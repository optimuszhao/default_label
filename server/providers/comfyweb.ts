// 对接朋友部署的「ComfyUI Web API」（FastAPI，/docs 可查看）。
//
//   登录        POST /api/auth/login            {email, password} → {token}
//   文生图      POST /api/generate/text2img     JSON
//   图生图      POST /api/generate/img2img      multipart，单张参考图
//   文生视频    POST /api/generate/text2video   JSON，时长 4–15 秒，宽高 32 的倍数
//   图生视频    POST /api/generate/img2video    multipart，首帧
//   查询任务    GET  /api/tasks/{id}            status: pending/running/postprocessing/completed/failed
//   下载产物    GET  /api/products/download/{video|image}/{filename}
//
// 接口文档没有写明「提交」和「查询」的响应字段，下面的解析尽量宽松；
// 遇到认不出的响应会把原文打到日志里（npm run probe:comfy 可以直接看原始返回）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { llmConfigured, llmHealthy, openAiChat } from './llm.ts';
import {
  ProviderUnavailableError,
  type ChatMessage,
  type ChatOptions,
  type JobStatus,
  type Provider,
  type ProviderImageInput,
  type ProviderOutput,
  type SubmitInput,
} from './types.ts';

type Json = Record<string, unknown>;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

let token = config.comfyToken;
let loginInflight: Promise<string> | null = null;
const warned = new Set<string>();

function base(): string {
  if (!config.genApiBase) throw new ProviderUnavailableError('尚未配置 GEN_API_BASE（生成服务地址）');
  return config.genApiBase;
}

function warnOnce(key: string, message: string, data: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[comfyweb] ${message}:`, JSON.stringify(data).slice(0, 2000));
}

async function login(): Promise<string> {
  if (!config.comfyEmail || !config.comfyPassword) {
    throw new ProviderUnavailableError('尚未配置 COMFY_EMAIL / COMFY_PASSWORD（生成服务账号）');
  }
  loginInflight ??= (async () => {
    let response: Response;
    try {
      response = await fetch(`${base()}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: config.comfyEmail, password: config.comfyPassword }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ProviderUnavailableError(`无法连接生成服务：${(error as Error).message}`);
    }
    const data = (await response.json().catch(() => ({}))) as Json;
    if (response.status >= 500) throw new ProviderUnavailableError(`生成服务登录失败（HTTP ${response.status}）`);
    if (!response.ok || typeof data.token !== 'string') {
      // 账号密码错误属于配置问题，任务继续排队等管理员修正，不消耗重试次数
      throw new ProviderUnavailableError(`生成服务登录失败：${errorText(data) ?? `HTTP ${response.status}`}`);
    }
    token = data.token;
    return token;
  })().finally(() => {
    loginInflight = null;
  });
  return loginInflight;
}

function errorText(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Json;
  if (typeof d.detail === 'string') return d.detail;
  if (Array.isArray(d.detail)) {
    return d.detail.map((item) => (item as Json).msg ?? JSON.stringify(item)).join('；');
  }
  for (const key of ['error', 'message', 'msg']) if (typeof d[key] === 'string') return d[key] as string;
  return null;
}

/** 带登录态的请求：401 时自动重新登录一次；5xx / 网络错误视为服务暂不可用 */
async function call(method: string, pathname: string, body?: BodyInit, json = true, timeoutMs = 60_000): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!token) await login();
    let response: Response;
    try {
      response = await fetch(`${base()}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(json && body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ProviderUnavailableError(`无法连接生成服务：${(error as Error).message}`);
    }
    if (response.status === 401 && attempt === 0) {
      token = '';
      continue;
    }
    if (response.status >= 500 || response.status === 429 || response.status === 401) {
      const text = await response.text().catch(() => '');
      throw new ProviderUnavailableError(`生成服务暂不可用（HTTP ${response.status}）${text ? `：${text.slice(0, 200)}` : ''}`);
    }
    return response;
  }
  throw new ProviderUnavailableError('生成服务登录失效');
}

async function callJson(method: string, pathname: string, body?: BodyInit, json = true): Promise<Json> {
  const response = await call(method, pathname, body, json);
  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) throw new Error(errorText(data) ?? `生成服务返回错误（HTTP ${response.status}）`);
  return (data && typeof data === 'object' ? data : { value: data }) as Json;
}

const round = (value: number, step: number) => Math.max(step, Math.round(value / step) * step);

/** 从提交响应里找任务号：task_id / id / data.task_id …… */
function findTaskId(data: Json): string | null {
  const candidates = [data.task_id, data.id, (data.data as Json | undefined)?.task_id, (data.data as Json | undefined)?.id, (data.task as Json | undefined)?.id];
  const found = candidates.find((value) => typeof value === 'number' || (typeof value === 'string' && value));
  return found === undefined ? null : String(found);
}

async function imagePart(image: ProviderImageInput): Promise<Blob> {
  return new Blob([await fs.readFile(image.path)], { type: image.mime });
}

function videoPrompt(input: SubmitInput): string {
  const motion = input.params.cameraMotion;
  return motion && motion !== '自动' ? `${input.prompt}。镜头运动：${motion}` : input.prompt;
}

async function submitOne(input: SubmitInput, seedOffset: number): Promise<string> {
  const seed = input.params.seed == null ? 0 : input.params.seed + seedOffset;
  let data: Json;
  switch (input.type) {
    case 't2i':
      data = await callJson(
        'POST',
        '/api/generate/text2img',
        JSON.stringify({
          prompt: input.prompt,
          negative_prompt: input.negativePrompt,
          width: round(input.params.width, 16),
          height: round(input.params.height, 16),
          steps: input.params.steps ?? 25,
          seed,
        }),
      );
      break;
    case 'i2i': {
      const reference = input.images.find((image) => image.role === 'reference');
      if (!reference) throw new Error('图生图缺少参考图');
      const form = new FormData();
      form.append('file', await imagePart(reference), path.basename(reference.path));
      form.append('prompt', input.prompt);
      form.append('negative_prompt', input.negativePrompt);
      form.append('width', String(round(input.params.width, 16)));
      form.append('height', String(round(input.params.height, 16)));
      form.append('steps', String(input.params.steps ?? 25));
      form.append('seed', String(seed));
      data = await callJson('POST', '/api/generate/img2img', form, false);
      break;
    }
    case 't2v':
      data = await callJson(
        'POST',
        '/api/generate/text2video',
        JSON.stringify({
          prompt: videoPrompt(input),
          duration: Math.min(15, Math.max(4, input.params.duration ?? 5)),
          width: round(input.params.width, 32),
          height: round(input.params.height, 32),
          seed,
        }),
      );
      break;
    case 'i2v': {
      const first = input.images.find((image) => image.role === 'first_frame');
      if (!first) throw new Error('图生视频缺少首帧');
      const form = new FormData();
      form.append('file', await imagePart(first), path.basename(first.path));
      form.append('prompt', videoPrompt(input));
      form.append('duration', String(Math.min(15, Math.max(4, input.params.duration ?? 5))));
      form.append('width', String(round(input.params.width, 32)));
      form.append('height', String(round(input.params.height, 32)));
      form.append('seed', String(seed));
      data = await callJson('POST', '/api/generate/img2video', form, false);
      break;
    }
  }
  const id = findTaskId(data);
  if (!id) {
    warnOnce('submit', '提交响应里没有找到任务号', data);
    throw new Error('生成服务没有返回任务号');
  }
  return id;
}

// ---------------- 解析任务结果 ----------------

/** 收集响应里所有像文件的字符串（文件名、相对路径、完整地址） */
function collectFiles(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 5 || value == null) return out;
  if (typeof value === 'string') {
    if (/\.(png|jpe?g|webp|gif|mp4|webm|mov)(\?.*)?$/i.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, out, depth + 1);
  } else if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Json)) {
      // 输入图（参考图、首帧）不是产物
      if (/input|source|reference|first_frame|upload/i.test(key)) continue;
      collectFiles(item, out, depth + 1);
    }
  }
  return out;
}

function kindOf(file: string, fallback: 'image' | 'video'): 'image' | 'video' {
  if (/\.(mp4|webm|mov)(\?.*)?$/i.test(file)) return 'video';
  if (/\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(file)) return 'image';
  return fallback;
}

function downloadPath(file: string, kind: 'image' | 'video'): string {
  if (/^https?:\/\//i.test(file)) return file;
  if (file.startsWith('/')) return file;
  // 只有文件名：走产物下载接口
  return `/api/products/download/${kind}/${encodeURIComponent(path.basename(file))}`;
}

async function download(file: string, fallbackKind: 'image' | 'video'): Promise<ProviderOutput> {
  const kind = kindOf(file, fallbackKind);
  const target = downloadPath(file, kind);
  const response = /^https?:\/\//i.test(target)
    ? await fetch(target, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(300_000) })
    : await call('GET', target, undefined, false, 300_000);
  if (!response.ok) throw new Error(`下载生成结果失败（HTTP ${response.status}）：${path.basename(file)}`);
  const ext = path.extname(file.split('?')[0]).slice(1).toLowerCase();
  const mime = response.headers.get('content-type')?.split(';')[0] || MIME_BY_EXT[ext] || (kind === 'video' ? 'video/mp4' : 'image/png');
  return { kind, mime: MIME_BY_EXT[ext] ?? mime, base64: Buffer.from(await response.arrayBuffer()).toString('base64') };
}

function progressOf(data: Json): number | undefined {
  for (const key of ['progress', 'percent', 'percentage']) {
    const value = Number(data[key]);
    if (Number.isFinite(value)) return value > 1 ? value / 100 : value;
  }
  return undefined;
}

interface SubJob {
  id: string;
  state: JobStatus['state'];
  progress: number;
  files: string[];
  error?: string;
}

async function pollOne(id: string): Promise<SubJob> {
  const raw = await callJson('GET', `/api/tasks/${encodeURIComponent(id)}`);
  const data = (raw.data && typeof raw.data === 'object' ? raw.data : raw) as Json;
  const status = String(data.status ?? data.state ?? '').toLowerCase();
  const progress = progressOf(data);
  if (status === 'failed' || status === 'error') {
    return { id, state: 'failed', progress: 0, files: [], error: errorText(data) ?? (data.error_message as string) ?? '生成失败' };
  }
  if (status === 'completed' || status === 'succeeded' || status === 'success' || status === 'done') {
    const files = [...new Set(collectFiles(data))];
    if (!files.length) warnOnce(`completed-no-files`, '任务已完成，但响应里没找到产物文件', raw);
    return { id, state: 'succeeded', progress: 1, files };
  }
  if (status === 'running' || status === 'postprocessing' || status === 'processing') {
    // 后处理（超分、转码）阶段没有进度时，至少显示在 90% 以上
    const fallback = status === 'postprocessing' ? 0.92 : 0.1;
    return { id, state: 'running', progress: progress ?? fallback, files: [] };
  }
  if (status !== 'pending' && status !== 'queued') warnOnce(`status-${status}`, `未知的任务状态「${status}」`, raw);
  return { id, state: 'pending', progress: progress ?? 0, files: [] };
}

// ---------------- Provider ----------------

export class ComfyWebProvider implements Provider {
  readonly name = 'comfyweb';

  async health() {
    let reachable = false;
    let message: string | undefined;
    try {
      const response = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(5_000) });
      reachable = response.ok;
      if (!response.ok) message = `生成服务健康检查失败（HTTP ${response.status}）`;
      else {
        const data = (await response.json().catch(() => ({}))) as Json;
        // 常见写法：{status: "ok"} / {comfyui: false}；明确说不可用时才判为不可用
        if (data.status && !['ok', 'healthy', 'up', true].includes(data.status as string)) {
          reachable = false;
          message = `生成服务状态：${String(data.status)}`;
        }
        if (data.comfyui === false || data.comfy === false) {
          reachable = false;
          message = 'ComfyUI 未连接';
        }
      }
    } catch (error) {
      message = (error as Error).message;
    }
    const llm = llmConfigured() ? await llmHealthy() : false;
    return {
      image: reachable,
      video: reachable,
      llm,
      message: message ?? (llmConfigured() ? undefined : '未配置语言模型，AI 写作助手不可用'),
    };
  }

  async submit(input: SubmitInput) {
    // 对方每次只出一个结果；多张图拆成多个任务，任务号用逗号拼起来
    const count = input.type === 't2i' || input.type === 'i2i' ? Math.min(Math.max(input.params.count || 1, 1), 4) : 1;
    const ids: string[] = [];
    for (let index = 0; index < count; index++) ids.push(await submitOne(input, index));
    const kind = input.type.endsWith('v') ? 'video' : 'image';
    return { jobId: `${kind}:${ids.join(',')}` };
  }

  async poll(jobId: string): Promise<JobStatus> {
    const [kind, list] = jobId.includes(':') ? (jobId.split(':', 2) as ['image' | 'video', string]) : ['image' as const, jobId];
    const jobs = await Promise.all(list.split(',').map(pollOne));
    const failed = jobs.find((job) => job.state === 'failed');
    if (failed) return { state: 'failed', error: failed.error };
    if (jobs.every((job) => job.state === 'succeeded')) {
      const files = jobs.flatMap((job) => job.files);
      if (!files.length) return { state: 'failed', error: '任务完成但没有找到产物文件（详见服务日志）' };
      const outputs: ProviderOutput[] = [];
      for (const file of files) outputs.push(await download(file, kind));
      return { state: 'succeeded', progress: 1, outputs };
    }
    const progress = jobs.reduce((sum, job) => sum + job.progress, 0) / jobs.length;
    return { state: jobs.some((job) => job.state === 'running') ? 'running' : 'pending', progress };
  }

  async cancel() {
    // 对方没有取消接口：织影这边标记取消即可，生成结果会被忽略
  }

  async chat(messages: ChatMessage[], options?: ChatOptions) {
    return openAiChat(messages, options);
  }
}
