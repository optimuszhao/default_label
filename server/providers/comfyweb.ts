// 对接朋友部署的「ComfyUI Web API」（FastAPI，/docs 可查看）。
//
//   登录        POST /api/auth/login            {appid, secret} → {token, appid, user_id}，token 有效 72 小时
//   校验        GET  /api/auth/verify           → {valid, appid, user_id}，失效时 401
//   文生图      POST /api/generate/text2img     JSON，Qwen-Image，宽高 16 的倍数
//   图生图      POST /api/generate/img2img      multipart，单张参考图
//   文生视频    POST /api/generate/text2video   JSON，时长 4–15 秒，宽高 32 的倍数，自动 2x 超分
//   图生视频    POST /api/generate/img2video    multipart，首帧
//   提交响应    {task_id, message}
//   查询任务    GET  /api/tasks/{task_id}       {status, stage, result:{category, files, upscaled}, error}
//               status: pending → running → postprocessing（转码 / 超分）→ completed / failed
//   下载产物    GET  /api/products/download/{video|image}/{filename}
//   取消任务    POST /api/tasks/{task_id}/cancel     排队中的从队列删掉，执行中的直接中断；已结束返回 400；之后状态为 cancelled
//   语言模型    POST /api/llm/v1/chat/completions    OpenAI 兼容；GET /api/llm/models 列出模型
//   分镜扩写    POST /api/llm/expand-prompt          {scene, duration} → {prompt}（按对方视频模型的分镜写法）
//
// 对方可以同时接收多个任务，在 ComfyUI 内部排队；视频含超分单条约 15–30 分钟。
// 遇到认不出的响应会把原文打到日志里（npm run probe:comfy 可以直接看原始返回）。
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DEFAULT_CAPABILITIES, IMAGE_RESOLUTIONS, type Capabilities } from '../../shared/operator.ts';
import type { TokenStatus } from '../../shared/types.ts';
import { newTempFile } from '../files.ts';
import { logger } from '../log.ts';
import {
  ProviderUnavailableError,
  type ChatMessage,
  type ChatOptions,
  type JobStatus,
  type OperatorContext,
  type OperatorHealth,
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

/** 对方 token 有效期 72 小时（文档）；JWT 里有 exp 时以 exp 为准 */
const TOKEN_LIFETIME_MS = 72 * 60 * 60 * 1000;
/** 提前这么久换新，避免长视频任务中途过期 */
const RENEW_BEFORE_MS = 60 * 60 * 1000;
/** 健康检查里校验 token 的间隔 */
const VERIFY_EVERY_MS = 5 * 60 * 1000;

/** token 是 JWT 时读出真实到期时间 */
function jwtExpiry(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** 去掉模型输出里的思考过程（<think>…</think>） */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function errorText(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Json;
  if (typeof d.detail === 'string' && d.detail) return d.detail;
  if (Array.isArray(d.detail)) {
    return d.detail.map((item) => (item as Json).msg ?? JSON.stringify(item)).join('；');
  }
  for (const key of ['error', 'message', 'msg']) if (typeof d[key] === 'string' && d[key]) return d[key] as string;
  return null;
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

interface StoredToken {
  token: string;
  issuedAt: number | null;
  expiresAt: number | null;
  basis: TokenStatus['expiresBasis'];
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

function downloadPath(file: string, category: 'image' | 'video'): string {
  if (/^https?:\/\//i.test(file)) return file;
  if (file.startsWith('/')) return file;
  // 只有文件名：走产物下载接口 /api/products/download/{category}/{filename}
  return `/api/products/download/${category}/${encodeURIComponent(path.basename(file))}`;
}

function progressOf(data: Json): number | undefined {
  for (const key of ['progress', 'percent', 'percentage']) {
    if (data[key] == null || data[key] === '') continue;
    const value = Number(data[key]);
    if (Number.isFinite(value)) return value > 1 ? value / 100 : value;
  }
  return undefined;
}

/** 对方不返回进度百分比：按经验耗时估一个，只用于进度条，不影响判断 */
const EXPECTED_MS = { image: 60_000, video: 15 * 60_000 };
const runningSince = new Map<string, number>();

function estimate(id: string, kind: 'image' | 'video', status: string): number {
  if (status === 'postprocessing') return 0.9;
  if (status !== 'running') return 0;
  const since = runningSince.get(id) ?? Date.now();
  runningSince.set(id, since);
  // 渐近曲线：到预计耗时时约 60%，之后越来越慢，最多 88%
  const ratio = (Date.now() - since) / EXPECTED_MS[kind];
  return Math.min(0.88, 0.05 + 0.83 * (1 - Math.exp(-ratio)));
}

const STAGE_FALLBACK: Record<string, string> = {
  pending: '在生成服务排队中',
  queued: '在生成服务排队中',
  running: '生成中',
  processing: '生成中',
  postprocessing: '转码 / 超分中',
};

interface OutputFile {
  name: string;
  category: 'image' | 'video';
}

interface SubJob {
  id: string;
  state: JobStatus['state'];
  progress: number;
  stage?: string;
  files: OutputFile[];
  error?: string;
}

function asList(value: unknown): string[] {
  if (typeof value === 'string' && value) return [value];
  return [...new Set(collectFiles(value))];
}

/** 文档里的 result：{category, files:[原片], upscaled:[超分版]}，有超分版时只取超分版 */
function outputFiles(data: Json, kind: 'image' | 'video'): OutputFile[] {
  const result = data.result && typeof data.result === 'object' ? (data.result as Json) : null;
  const category = result?.category === 'image' || result?.category === 'video' ? result.category : kind;
  let names: string[] = [];
  if (result) {
    names = asList(result.upscaled);
    if (!names.length) names = asList(result.files);
  }
  // 兼容其他写法：在整个响应里找像文件名的字段
  if (!names.length) names = [...new Set(collectFiles(data))];
  return names.map((name) => ({ name, category: kindOf(name, category) }));
}

function parseJobId(jobId: string): { kind: 'image' | 'video'; ids: string[] } {
  const [kind, list] = jobId.includes(':') ? (jobId.split(':', 2) as ['image' | 'video', string]) : (['image', jobId] as const);
  return { kind: kind === 'video' ? 'video' : 'image', ids: list.split(',').filter(Boolean) };
}

/**
 * 按接口文档声明能力：图生图只收一张参考图、没有重绘强度和 CFG；
 * 视频时长 4–15 秒、宽高 32 的倍数、没有尾帧和负向词，输出自动 2x 超分。
 * 16:9 的 1344×768 是文档默认值，其他比例的尺寸待朋友确认（ROADMAP §9.2 第 8 项）。
 */
const COMFYWEB_CAPABILITIES: Capabilities = {
  operator: 'comfyweb',
  image: {
    ...DEFAULT_CAPABILITIES.image,
    maxReferences: 1,
    // 图生图 denoise：越小越贴近参考图
    strength: true,
    cfg: false,
    resolutions: IMAGE_RESOLUTIONS,
    sizeStep: 16,
  },
  video: {
    maxReferences: 0,
    firstFrame: true,
    lastFrame: false,
    strength: false,
    cfg: false,
    steps: false,
    negativePrompt: false,
    maxCount: 1,
    durations: [4, 5, 6, 8, 10, 12, 15],
    resolutions: [],
    sizes: [
      { aspectRatio: '16:9', width: 1344, height: 768 },
      { aspectRatio: '9:16', width: 768, height: 1344 },
      { aspectRatio: '1:1', width: 1024, height: 1024 },
      { aspectRatio: '4:3', width: 1152, height: 864 },
      { aspectRatio: '3:4', width: 864, height: 1152 },
      { aspectRatio: '21:9', width: 1536, height: 640 },
    ],
    sizeStep: 32,
    note: '输出自动 2x 超分',
  },
};

export class ComfyWebProvider implements Provider {
  readonly kind = 'comfyweb';
  readonly name: string;
  private readonly ctx: OperatorContext;
  private token = '';
  /** 到这个时间就主动换新 */
  private refreshAt = 0;
  private verifiedAt = 0;
  private loginInflight: Promise<string> | null = null;
  private readonly warned = new Set<string>();
  private readonly status = {
    issuedAt: null as number | null,
    expiresAt: null as number | null,
    expiresBasis: null as TokenStatus['expiresBasis'],
    lastVerifyAt: null as number | null,
    lastVerifyOk: null as boolean | null,
    lastVerifyMessage: null as string | null,
    lastLoginError: null as string | null,
  };

  constructor(ctx: OperatorContext) {
    this.ctx = ctx;
    this.name = ctx.name;
    // 重启后恢复上次保存的令牌，不必重新登录
    const saved = ctx.secret('token');
    if (saved) {
      try {
        this.adopt(JSON.parse(saved) as StoredToken, false);
      } catch {
        ctx.saveSecret('token', null);
      }
    }
  }

  capabilities(): Capabilities {
    return COMFYWEB_CAPABILITIES;
  }

  // ---------------- 令牌 ----------------

  private base(): string {
    if (!this.ctx.baseUrl) throw new ProviderUnavailableError('算子没有配置服务地址');
    return this.ctx.baseUrl;
  }

  private warnOnce(key: string, message: string, data: unknown): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    logger.warn({ operator: this.ctx.id, raw: JSON.stringify(data).slice(0, 2000) }, message);
  }

  private adopt(stored: StoredToken, persist = true): void {
    this.token = stored.token;
    this.status.issuedAt = stored.issuedAt;
    this.status.expiresAt = stored.expiresAt;
    this.status.expiresBasis = stored.basis;
    this.refreshAt = stored.expiresAt ? stored.expiresAt - RENEW_BEFORE_MS : Number.POSITIVE_INFINITY;
    if (persist) this.ctx.saveSecret('token', JSON.stringify(stored));
  }

  private forgetToken(): void {
    this.token = '';
    this.refreshAt = 0;
    this.verifiedAt = 0;
    this.status.issuedAt = null;
    this.status.expiresAt = null;
    this.status.expiresBasis = null;
    this.ctx.saveSecret('token', null);
  }

  private recordVerify(ok: boolean, message: string | null): void {
    this.status.lastVerifyAt = Date.now();
    this.status.lastVerifyOk = ok;
    this.status.lastVerifyMessage = message;
  }

  private credentials(): Json {
    const secret = this.ctx.secret('secret');
    if (this.ctx.appid && secret) return { appid: this.ctx.appid, secret };
    throw new ProviderUnavailableError('算子没有配置 API ID 和密钥');
  }

  private async login(): Promise<string> {
    let body: string;
    try {
      body = JSON.stringify(this.credentials());
    } catch (error) {
      this.status.lastLoginError = (error as Error).message;
      throw error;
    }
    this.loginInflight ??= (async () => {
      let response: Response;
      try {
        response = await fetch(`${this.base()}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        throw new ProviderUnavailableError(`无法连接生成服务：${(error as Error).message}`);
      }
      const data = (await response.json().catch(() => ({}))) as Json;
      if (response.status >= 500) throw new ProviderUnavailableError(`生成服务登录失败（HTTP ${response.status}）`);
      if (!response.ok || typeof data.token !== 'string' || !data.token) {
        // 密钥错误属于配置问题，任务继续排队等管理员修正，不消耗重试次数
        throw new ProviderUnavailableError(`生成服务登录失败：${errorText(data) ?? `HTTP ${response.status}`}`);
      }
      const issuedAt = Date.now();
      const exp = jwtExpiry(data.token);
      this.adopt({ token: data.token, issuedAt, expiresAt: exp ?? issuedAt + TOKEN_LIFETIME_MS, basis: exp ? 'jwt' : 'assumed' });
      this.status.lastLoginError = null;
      this.verifiedAt = Date.now();
      logger.info({ operator: this.ctx.id }, '已换取算子令牌');
      return this.token;
    })()
      .catch((error) => {
        this.status.lastLoginError = (error as Error).message;
        throw error;
      })
      .finally(() => {
        this.loginInflight = null;
      });
    return this.loginInflight;
  }

  private async ensureToken(): Promise<string> {
    if (!this.token || Date.now() >= this.refreshAt) return this.login();
    return this.token;
  }

  /** 调用 /api/auth/verify 校验当前 token（没有 token 时会先登录） */
  private async verifyNow(): Promise<Json> {
    const response = await this.call('GET', '/api/auth/verify', undefined, true, 10_000);
    const data = (await response.json().catch(() => ({}))) as Json;
    if (!response.ok || data.valid === false) {
      const message = `生成服务凭证无效：${errorText(data) ?? `HTTP ${response.status}`}`;
      this.recordVerify(false, message);
      this.forgetToken();
      throw new ProviderUnavailableError(message);
    }
    this.verifiedAt = Date.now();
    const who = [typeof data.appid === 'string' ? `appid=${data.appid}` : '', data.user_id != null ? `user_id=${data.user_id}` : '']
      .filter(Boolean)
      .join(' · ');
    this.recordVerify(true, who || '令牌有效');
    return data;
  }

  /** 带登录态的请求：401 时自动重新登录一次；5xx / 网络错误视为服务暂不可用 */
  private async call(method: string, pathname: string, body?: BodyInit, json = true, timeoutMs = 60_000): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.ensureToken();
      let response: Response;
      try {
        response = await fetch(`${this.base()}${pathname}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(json && body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new ProviderUnavailableError(`无法连接生成服务：${(error as Error).message}`);
      }
      if (response.status === 401 && attempt === 0) {
        this.forgetToken();
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

  private async callJson(method: string, pathname: string, body?: BodyInit, json = true): Promise<Json> {
    return this.callJsonTimeout(method, pathname, body, 60_000, json);
  }

  private async callJsonTimeout(method: string, pathname: string, body: BodyInit | undefined, timeoutMs: number, json = true): Promise<Json> {
    const response = await this.call(method, pathname, body, json, timeoutMs);
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

  // ---------------- 提交 ----------------

  private async submitOne(input: SubmitInput, seedOffset: number, count = 1): Promise<string> {
    const seed = input.params.seed == null ? 0 : input.params.seed + seedOffset;
    let data: Json;
    switch (input.type) {
      case 't2i':
        data = await this.callJson(
          'POST',
          '/api/generate/text2img',
          JSON.stringify({
            prompt: input.prompt,
            negative_prompt: input.negativePrompt,
            width: round(input.params.width, 16),
            height: round(input.params.height, 16),
            steps: input.params.steps ?? 25,
            seed,
            count,
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
        form.append('count', String(count));
        if (input.params.strength != null) form.append('denoise', String(Math.min(1, Math.max(0.05, input.params.strength))));
        data = await this.callJson('POST', '/api/generate/img2img', form, false);
        break;
      }
      case 't2v':
        data = await this.callJson(
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
        data = await this.callJson('POST', '/api/generate/img2video', form, false);
        break;
      }
    }
    const id = findTaskId(data);
    if (!id) {
      this.warnOnce('submit', '提交响应里没有找到任务号', data);
      throw new Error('生成服务没有返回任务号');
    }
    return id;
  }

  // ---------------- 查询与下载 ----------------

  /** 只有和算子同源的地址才带 token，防止凭证被发到别的主机 */
  private sameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.base()).origin;
    } catch {
      return false;
    }
  }

  /** 流式写入临时文件并计算 sha256，不把整段视频读进内存 */
  private async download(file: OutputFile): Promise<ProviderOutput> {
    const kind = kindOf(file.name, file.category);
    const target = downloadPath(file.name, file.category);
    // 超分后的视频可能有几十 MB，给足下载时间
    let response: Response;
    if (/^https?:\/\//i.test(target)) {
      const headers: Record<string, string> = this.sameOrigin(target) ? { authorization: `Bearer ${await this.ensureToken()}` } : {};
      try {
        response = await fetch(target, { headers, signal: AbortSignal.timeout(600_000) });
      } catch (error) {
        throw new ProviderUnavailableError(`下载生成结果失败：${(error as Error).message}`);
      }
    } else {
      response = await this.call('GET', target, undefined, false, 600_000);
    }
    if (response.status === 404) throw new Error(`生成服务上找不到产物文件：${path.basename(file.name)}`);
    if (!response.ok || !response.body) {
      throw new ProviderUnavailableError(`下载生成结果失败（HTTP ${response.status}）：${path.basename(file.name)}`);
    }
    const ext = path.extname(file.name.split('?')[0]).slice(1).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? response.headers.get('content-type')?.split(';')[0] ?? (kind === 'video' ? 'video/mp4' : 'image/png');
    const temp = await newTempFile();
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(temp));
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw new ProviderUnavailableError(`下载生成结果中断：${(error as Error).message}`);
    }
    const expected = Number(response.headers.get('content-length'));
    if (expected && bytes !== expected) {
      await fs.rm(temp, { force: true });
      throw new ProviderUnavailableError(`下载生成结果不完整（${bytes}/${expected} 字节）`);
    }
    if (!bytes) {
      await fs.rm(temp, { force: true });
      throw new Error(`生成服务返回了空文件：${path.basename(file.name)}`);
    }
    logger.info({ operator: this.ctx.id, file: path.basename(file.name), bytes, sha256: hash.digest('hex').slice(0, 16) }, '已下载产物');
    return { kind, mime, filePath: temp };
  }

  private async pollOne(id: string, kind: 'image' | 'video'): Promise<SubJob> {
    const raw = await this.callJson('GET', `/api/tasks/${encodeURIComponent(id)}`);
    const data = (raw.data && typeof raw.data === 'object' ? raw.data : raw) as Json;
    const status = String(data.status ?? data.state ?? '').toLowerCase();
    const stage = (typeof data.stage === 'string' && data.stage.trim()) || STAGE_FALLBACK[status];
    // 对方那边被取消（他自己取消、服务重启清理）：直接判失败，不再等到超时
    if (status === 'cancelled' || status === 'canceled') return { id, state: 'failed', progress: 0, files: [], error: '生成服务那边取消了这个任务' };
    if (status === 'failed' || status === 'error') {
      runningSince.delete(id);
      return { id, state: 'failed', progress: 0, files: [], error: errorText(data) ?? (data.error_message as string) ?? '生成失败' };
    }
    if (status === 'completed' || status === 'succeeded' || status === 'success' || status === 'done') {
      runningSince.delete(id);
      const files = outputFiles(data, kind);
      if (!files.length) this.warnOnce('completed-no-files', '任务已完成，但响应里没找到产物文件', raw);
      return { id, state: 'succeeded', progress: 1, files };
    }
    const progress = progressOf(data) ?? estimate(id, kind, status);
    if (status === 'running' || status === 'postprocessing' || status === 'processing') {
      return { id, state: 'running', progress, stage, files: [] };
    }
    if (status !== 'pending' && status !== 'queued') this.warnOnce(`status-${status}`, `未知的任务状态「${status}」`, raw);
    return { id, state: 'pending', progress, stage, files: [] };
  }

  // ---------------- Provider 接口 ----------------

  async health(): Promise<OperatorHealth> {
    let reachable = false;
    let message: string | undefined;
    try {
      const response = await fetch(`${this.base()}/health`, { signal: AbortSignal.timeout(5_000) });
      reachable = response.ok;
      let verifyEvery = VERIFY_EVERY_MS;
      if (response.status === 404) {
        // 对方没有 /health：改用 verify 判断是否在线，校验频率提高到 30 秒一次
        reachable = true;
        verifyEvery = 30_000;
      } else if (!response.ok) message = `生成服务健康检查失败（HTTP ${response.status}）`;
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
      // 服务在线时顺便确认凭证可用：密钥配错时后台直接看到原因
      if (reachable && Date.now() - this.verifiedAt > verifyEvery) await this.verifyNow();
    } catch (error) {
      reachable = false;
      message = (error as Error).message;
    }
    return { image: reachable, video: reachable, message };
  }

  async submit(input: SubmitInput) {
    const count = input.type === 't2i' || input.type === 'i2i' ? Math.min(Math.max(input.params.count || 1, 1), 4) : 1;
    const kind = input.type.endsWith('v') ? 'video' : 'image';
    // 没锁种子：多张图合成一个任务提交（对方一次最多 16 张，少排几次队）；
    // 锁定了种子：拆成多个任务，第 n 张用 种子+n，每张都能复现（对方合并出图时第 2 张起不是 种子+n，实测无法复现）
    if (count > 1 && !input.seedLocked) return { jobId: `${kind}:${await this.submitOne(input, 0, count)}` };
    const ids: string[] = [];
    for (let index = 0; index < count; index++) ids.push(await this.submitOne(input, index));
    return { jobId: `${kind}:${ids.join(',')}` };
  }

  pollIntervalMs(jobId: string): number {
    const settings = this.ctx.settings;
    return parseJobId(jobId).kind === 'video' ? settings.videoPollMs : settings.imagePollMs;
  }

  async poll(jobId: string): Promise<JobStatus> {
    const { kind, ids } = parseJobId(jobId);
    const jobs = await Promise.all(ids.map((id) => this.pollOne(id, kind)));
    const failed = jobs.find((job) => job.state === 'failed');
    if (failed) return { state: 'failed', error: failed.error };
    if (jobs.every((job) => job.state === 'succeeded')) {
      const files = jobs.flatMap((job) => job.files);
      if (!files.length) return { state: 'failed', error: '任务完成但没有找到产物文件（详见服务日志）' };
      const outputs: ProviderOutput[] = [];
      try {
        for (const file of files) outputs.push(await this.download(file));
      } catch (error) {
        await Promise.all(outputs.map((output) => output.filePath && fs.rm(output.filePath, { force: true })));
        throw error;
      }
      // 一个对方任务出了多张图（合并提交）：第 1 张就是提交的种子，第 2 张起种子未知
      if (ids.length === 1 && outputs.length > 1) outputs.forEach((output, index) => index > 0 && (output.seed = null));
      return { state: 'succeeded', progress: 1, outputs };
    }
    const progress = jobs.reduce((sum, job) => sum + job.progress, 0) / jobs.length;
    const active = jobs.find((job) => job.state === 'running') ?? jobs.find((job) => job.state === 'pending');
    const done = jobs.filter((job) => job.state === 'succeeded').length;
    const stage = jobs.length > 1 && active?.stage ? `${active.stage} · 已完成 ${done}/${jobs.length}` : active?.stage;
    return { state: jobs.some((job) => job.state === 'running') ? 'running' : 'pending', progress, stage };
  }

  /** 取消：对方队列里排着的删掉、正在跑的中断，显卡立即空出来；已结束的任务对方返回 400，忽略即可 */
  async cancel(jobId: string) {
    const { ids } = parseJobId(jobId);
    await Promise.all(
      ids.map(async (id) => {
        try {
          const response = await this.call('POST', `/api/tasks/${encodeURIComponent(id)}/cancel`, undefined, true, 15_000);
          if (!response.ok && response.status !== 400 && response.status !== 404) logger.warn({ operator: this.ctx.id, id, status: response.status }, '取消对方任务失败');
        } catch (error) {
          logger.warn({ err: error, operator: this.ctx.id, id }, '取消对方任务失败');
        }
      }),
    );
  }

  // ---------------- 语言模型 ----------------

  async llmModels(): Promise<string[]> {
    const response = await this.call('GET', '/api/llm/models', undefined, true, 10_000);
    if (!response.ok) return [];
    const data = (await response.json().catch(() => ({}))) as { models?: { name?: string }[] };
    return (data.models ?? []).map((model) => String(model.name ?? '')).filter(Boolean);
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    // Qwen3 一类模型默认先"思考"一大段再回答；写文案不需要，关掉能快好几倍
    const think = this.ctx.settings.llmThink === true;
    const list = think ? messages : messages.map((message, index) => (index === messages.length - 1 && message.role === 'user' ? { ...message, content: `${message.content}\n/no_think` } : message));
    const response = await this.call(
      'POST',
      '/api/llm/v1/chat/completions',
      JSON.stringify({ ...(this.ctx.settings.llmModel ? { model: this.ctx.settings.llmModel } : {}), messages: list, temperature: options.temperature ?? 0.8, stream: false }),
      true,
      180_000,
    );
    const text = await response.text();
    if (!response.ok) throw new Error(`语言模型返回错误（HTTP ${response.status}）：${text.slice(0, 300)}`);
    const data = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('语言模型没有返回内容');
    return stripThinking(content);
  }

  async storyboard(scene: string, duration: number): Promise<string> {
    const data = await this.callJsonTimeout('POST', '/api/llm/expand-prompt', JSON.stringify({ scene, duration: Math.min(15, Math.max(4, duration)), ...(this.ctx.settings.llmModel ? { model: this.ctx.settings.llmModel } : {}) }), 180_000);
    const prompt = typeof data.prompt === 'string' ? stripThinking(data.prompt) : '';
    if (!prompt) throw new Error('分镜扩写没有返回内容');
    return prompt;
  }

  // ---------------- 后台：令牌管理 ----------------

  tokenStatus(): TokenStatus {
    return {
      supported: true,
      operator: this.name,
      base: this.ctx.baseUrl,
      appid: this.ctx.appid || undefined,
      configured: Boolean(this.ctx.appid && this.ctx.secret('secret')) || Boolean(this.token),
      hasToken: Boolean(this.token),
      tokenPreview: this.token ? `${this.token.slice(0, 6)}…${this.token.slice(-4)}` : null,
      ...this.status,
    };
  }

  async verifyToken(): Promise<TokenStatus> {
    const started = Date.now();
    try {
      await this.verifyNow();
    } catch (error) {
      // verifyNow 自己记录了“凭证无效”；连不上、登录失败等其他错误在这里记录
      if (!this.status.lastVerifyAt || this.status.lastVerifyAt < started) this.recordVerify(false, (error as Error).message);
    }
    return this.tokenStatus();
  }

  async renewToken(): Promise<TokenStatus> {
    this.forgetToken();
    try {
      await this.login();
      await this.verifyNow();
    } catch (error) {
      this.recordVerify(false, (error as Error).message);
    }
    return this.tokenStatus();
  }

  clearToken(): TokenStatus {
    this.forgetToken();
    return this.tokenStatus();
  }

  /** 手动填入令牌（调试用），到期时间未知时标为 manual */
  setManualToken(token: string): TokenStatus {
    const exp = jwtExpiry(token);
    this.adopt({ token, issuedAt: Date.now(), expiresAt: exp, basis: exp ? 'jwt' : 'manual' });
    return this.tokenStatus();
  }

  revealToken(): string | null {
    return this.token || null;
  }

  /** 对方最近 100 条任务（后台“远端任务”页签） */
  async listRemote(): Promise<unknown[]> {
    const data = await this.callJson('GET', '/api/tasks');
    const list = Array.isArray(data) ? data : Array.isArray(data.value) ? data.value : Array.isArray(data.tasks) ? data.tasks : Array.isArray(data.data) ? data.data : [];
    return list as unknown[];
  }
}
