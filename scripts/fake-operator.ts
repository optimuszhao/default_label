// 假算子：按朋友的《ComfyUI Web API 文档》模拟全部接口，开发和测试时不占用真实 GPU。
//
//   npm run fake:operator               # 默认 http://127.0.0.1:9911，appid=dev / secret=dev
//   FAKE_PORT=9000 npm run fake:operator
//
// 织影这边配置：PROVIDER=comfyweb GEN_API_BASE=http://127.0.0.1:9911 COMFY_APPID=dev COMFY_SECRET=dev
//
// 测试用控制接口（不需要登录）：
//   POST /__control   {...场景}        修改场景，见下方 Scenario
//   POST /__reset                       恢复默认场景并清空任务和请求记录
//   GET  /__requests                    已收到的生成请求（含解析后的参数），用于断言
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import zlib from 'node:zlib';

interface Scenario {
  /** /health 的表现：ok / 404（接口不存在）/ 503 / down（连接直接断开） */
  health: 'ok' | '404' | '503' | 'down';
  /** 接下来 N 次提交返回 503 */
  submitFailures: number;
  /** 接下来 N 次任何需要登录的请求返回 401（模拟 token 失效） */
  unauthorized: number;
  /** 任务结局：成功 / 失败 / 只有原片没有超分 / 结果文件下载 404 */
  outcome: 'ok' | 'fail' | 'no-upscale' | 'missing-file';
  /** 各阶段耗时（毫秒） */
  pendingMs: number;
  runningMs: number;
  postprocessingMs: number;
  /** 下载产物前等待的时间 */
  downloadDelayMs: number;
  /** 只对视频产物生效的下载等待 */
  videoDownloadDelayMs: number;
  /** 设置后，结果里的文件改为这个前缀开头的绝对地址（模拟产物放在别的主机上） */
  resultBase: string;
  /** 视频产物大小（MB） */
  videoSizeMb: number;
  /** 提交接口先收下任务，再拖这么久才返回（模拟提交超时但实际已收下） */
  submitDelayMs: number;
}

const DEFAULT: Scenario = {
  health: 'ok',
  submitFailures: 0,
  unauthorized: 0,
  outcome: 'ok',
  pendingMs: 300,
  runningMs: 600,
  postprocessingMs: 300,
  downloadDelayMs: 0,
  videoDownloadDelayMs: 0,
  resultBase: '',
  videoSizeMb: 1,
  submitDelayMs: 0,
};

interface FakeTask {
  id: string;
  type: 'text2img' | 'img2img' | 'text2video' | 'img2video';
  prompt: string;
  params: Record<string, unknown>;
  createdAt: number;
  outcome: Scenario['outcome'];
  timing: Pick<Scenario, 'pendingMs' | 'runningMs' | 'postprocessingMs'>;
}

const APPID = process.env.FAKE_APPID ?? 'dev';
const SECRET = process.env.FAKE_SECRET ?? 'dev';

let scenario: Scenario = { ...DEFAULT };
let tokens = new Set<string>();
let tasks = new Map<string, FakeTask>();
let requests: { path: string; params: Record<string, unknown>; hasFile: boolean; at: number }[] = [];
let counter = 0;

// ---------------- 产物文件 ----------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 指定尺寸的纯色 PNG（真实可解码） */
export function makePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // RGB
  const row = Buffer.alloc(1 + width * 3, 0x40);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
}

/** 只有 ftyp / moov(mvhd, trak/tkhd) / mdat 的最小 MP4，足够读出宽高和时长 */
export function makeMp4Header(width: number, height: number, seconds: number): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16); // duration
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(3, 0); // version 0, flags enabled
  tkhd.writeUInt32BE(width * 65536, 76);
  tkhd.writeUInt32BE(height * 65536, 80);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2mp41', 'binary')),
    box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd))),
  ]);
}

// ---------------- 任务状态 ----------------

function stateOf(task: FakeTask): { status: string; stage: string } {
  const age = Date.now() - task.createdAt;
  const { pendingMs, runningMs, postprocessingMs } = task.timing;
  const video = task.type.includes('video');
  if (age < pendingMs) return { status: 'pending', stage: '' };
  if (task.outcome === 'fail' && age >= pendingMs) return { status: 'failed', stage: '' };
  if (age < pendingMs + runningMs) return { status: 'running', stage: video ? '视频生成中' : '图片生成中' };
  if (video && age < pendingMs + runningMs + postprocessingMs) return { status: 'postprocessing', stage: '超分中' };
  return { status: 'completed', stage: '' };
}

function taskJson(task: FakeTask) {
  const { status, stage } = stateOf(task);
  const video = task.type.includes('video');
  let result: Record<string, unknown> = {};
  if (status === 'completed') {
    result = video
      ? {
          category: 'video',
          files: [`api_video_${task.id}.mp4`],
          upscaled: task.outcome === 'no-upscale' ? [] : [`api_upscale_${task.id}.mp4`],
        }
      : { category: 'image', files: [`api_image_${task.id}.png`] };
    if (scenario.resultBase) {
      const category = result.category as string;
      for (const key of ['files', 'upscaled']) {
        const list = result[key] as string[] | undefined;
        if (list) result[key] = list.map((name) => `${scenario.resultBase}/api/products/download/${category}/${name}`);
      }
    }
  }
  return {
    type: task.type,
    status,
    stage,
    prompt: task.prompt,
    params: task.params,
    result,
    error: status === 'failed' ? 'ComfyUI 执行失败：显存不足' : '',
    created_at: new Date(task.createdAt).toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ---------------- HTTP ----------------

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const part of req) chunks.push(part as Buffer);
  return Buffer.concat(chunks);
}

/** 粗略解析 multipart：只取文本字段，并记录有没有文件 */
function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; hasFile: boolean } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const fields: Record<string, string> = {};
  let hasFile = false;
  if (!boundary) return { fields, hasFile };
  const parts = body.toString('latin1').split(`--${boundary[1] ?? boundary[2]}`);
  for (const part of parts) {
    const name = /name="([^"]+)"/.exec(part)?.[1];
    if (!name) continue;
    if (/filename="/.test(part)) {
      hasFile = true;
      continue;
    }
    const value = part.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
    fields[name] = Buffer.from(value, 'latin1').toString('utf8');
  }
  return { fields, hasFile };
}

const NUMERIC = new Set(['width', 'height', 'steps', 'seed', 'duration']);

function authorized(req: http.IncomingMessage): boolean {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (scenario.unauthorized > 0) {
    scenario.unauthorized--;
    tokens.clear();
    return false;
  }
  return Boolean(token && tokens.has(token));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://fake');
  const pathname = url.pathname;
  const body = await readBody(req);

  // ---- 控制接口 ----
  if (pathname === '/__control' && req.method === 'POST') {
    scenario = { ...scenario, ...(JSON.parse(body.toString() || '{}') as Partial<Scenario>) };
    return send(res, 200, scenario);
  }
  if (pathname === '/__reset' && req.method === 'POST') {
    scenario = { ...DEFAULT };
    tokens = new Set();
    tasks = new Map();
    requests = [];
    return send(res, 200, { ok: true });
  }
  if (pathname === '/__requests') return send(res, 200, requests);

  // ---- 公开接口 ----
  if (pathname === '/health') {
    if (scenario.health === 'down') return void req.socket.destroy();
    if (scenario.health === '404') return send(res, 404, { detail: 'Not Found' });
    if (scenario.health === '503') return send(res, 503, { status: 'error', comfyui: false });
    return send(res, 200, { status: 'ok' });
  }
  if (scenario.health === 'down') return void req.socket.destroy();

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const data = JSON.parse(body.toString() || '{}') as { appid?: string; secret?: string };
    if (data.appid !== APPID || data.secret !== SECRET) return send(res, 401, { detail: 'appid 或 secret 错误' });
    const token = `fake.${randomUUID()}`;
    tokens.add(token);
    return send(res, 200, { token, appid: APPID, user_id: 1 });
  }

  // ---- 需要登录 ----
  if (!authorized(req)) return send(res, 401, { detail: '未登录或 token 已过期' });

  if (pathname === '/api/auth/verify') return send(res, 200, { valid: true, appid: APPID, user_id: 1 });

  const generate = /^\/api\/generate\/(text2img|img2img|text2video|img2video)$/.exec(pathname);
  if (generate && req.method === 'POST') {
    const type = generate[1] as FakeTask['type'];
    let params: Record<string, unknown>;
    let hasFile = false;
    const contentType = req.headers['content-type'] ?? '';
    if (contentType.startsWith('multipart/')) {
      const parsed = parseMultipart(body, contentType);
      hasFile = parsed.hasFile;
      params = Object.fromEntries(Object.entries(parsed.fields).map(([k, v]) => [k, NUMERIC.has(k) ? Number(v) : v]));
      if (!hasFile) return send(res, 422, { detail: [{ msg: 'file 必填' }] });
    } else {
      params = JSON.parse(body.toString() || '{}');
    }
    requests.push({ path: pathname, params, hasFile, at: Date.now() });
    if (scenario.submitFailures > 0) {
      scenario.submitFailures--;
      return send(res, 503, { detail: 'ComfyUI 未就绪' });
    }
    const id = `fake-${++counter}`;
    const { prompt = '', ...rest } = params as { prompt?: string };
    tasks.set(id, {
      id,
      type,
      prompt,
      params: rest,
      createdAt: Date.now(),
      outcome: scenario.outcome,
      timing: { pendingMs: scenario.pendingMs, runningMs: scenario.runningMs, postprocessingMs: scenario.postprocessingMs },
    });
    if (scenario.submitDelayMs) await new Promise((resolve) => setTimeout(resolve, scenario.submitDelayMs));
    return send(res, 200, { task_id: id, message: '任务已提交' });
  }

  const one = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  if (one) {
    const task = tasks.get(decodeURIComponent(one[1]));
    if (!task) return send(res, 404, { detail: '任务不存在' });
    return send(res, 200, taskJson(task));
  }
  if (pathname === '/api/tasks') return send(res, 200, [...tasks.values()].slice(-100).reverse().map(taskJson));

  const download = /^\/api\/products\/download\/(image|video)\/([^/]+)$/.exec(pathname);
  if (download) {
    const filename = decodeURIComponent(download[2]);
    const id = /(fake-\d+)/.exec(filename)?.[1];
    const task = id ? tasks.get(id) : undefined;
    if (!task || task.outcome === 'missing-file') return send(res, 404, { detail: '文件不存在' });
    const delay = scenario.downloadDelayMs + (download[1] === 'video' ? scenario.videoDownloadDelayMs : 0);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const width = Number(task.params.width) || 1024;
    const height = Number(task.params.height) || 1024;
    if (download[1] === 'image') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return void res.end(makePng(width, height));
    }
    const upscaled = filename.includes('upscale');
    const header = makeMp4Header(upscaled ? width * 2 : width, upscaled ? height * 2 : height, Number(task.params.duration) || 5);
    const total = Math.max(header.length + 8, Math.round(scenario.videoSizeMb * 1024 * 1024));
    const mdatSize = total - header.length;
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(total) });
    res.write(header);
    const mdatHead = Buffer.alloc(8);
    mdatHead.writeUInt32BE(mdatSize);
    mdatHead.write('mdat', 4, 'ascii');
    res.write(mdatHead);
    // 分块流式发送，模拟大文件
    const block = Buffer.alloc(256 * 1024, 0);
    let left = mdatSize - 8;
    while (left > 0) {
      const size = Math.min(left, block.length);
      if (!res.write(size === block.length ? block : block.subarray(0, size))) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
      left -= size;
    }
    return void res.end();
  }

  if (pathname === '/api/products') {
    const done = [...tasks.values()].filter((task) => stateOf(task).status === 'completed');
    return send(res, 200, {
      video: done.filter((t) => t.type.includes('video')).map((t) => ({ filename: `api_upscale_${t.id}.mp4`, size: 0 })),
      image: done.filter((t) => !t.type.includes('video')).map((t) => ({ filename: `api_image_${t.id}.png`, size: 0 })),
    });
  }

  send(res, 404, { detail: 'Not Found' });
}

export function startFakeOperator(port: number, host = '127.0.0.1'): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) send(res, 500, { detail: String(error) });
      else res.destroy();
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_PORT) || 9911;
  await startFakeOperator(port, process.env.FAKE_HOST ?? '127.0.0.1');
  console.log(`[fake-operator] http://127.0.0.1:${port}  appid=${APPID} secret=${SECRET}`);
}
