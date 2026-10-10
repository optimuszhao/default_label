// 集成测试工具：起一个假算子（进程内）和一个真实的织影服务（子进程，临时数据目录），
// 测试通过 HTTP 黑盒调用，和用户在浏览器里的行为一致。
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { startFakeOperator } from '../scripts/fake-operator.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export class Client {
  cookie = '';
  constructor(readonly base: string) {}

  async raw(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const init: RequestInit = { method, headers: { ...headers } };
    if (this.cookie) (init.headers as Record<string, string>).cookie = this.cookie;
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${this.base}${pathname}`, init);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    return response;
  }

  async json<T = any>(method: string, pathname: string, body?: unknown): Promise<T> {
    const response = await this.raw(method, pathname, body);
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${pathname} → ${response.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  get = <T = any>(pathname: string) => this.json<T>('GET', pathname);
  post = <T = any>(pathname: string, body?: unknown) => this.json<T>('POST', pathname, body ?? {});
  patch = <T = any>(pathname: string, body?: unknown) => this.json<T>('PATCH', pathname, body ?? {});
  put = <T = any>(pathname: string, body?: unknown) => this.json<T>('PUT', pathname, body ?? {});
}

export interface Harness {
  base: string;
  operator: string;
  dataDir: string;
  /** 织影服务进程号（读 /proc 看内存） */
  pid: number;
  /** 修改假算子场景 */
  scenario(patch: Record<string, unknown>): Promise<void>;
  /** 假算子收到的生成请求 */
  operatorRequests(): Promise<{ path: string; params: Record<string, any>; hasFile: boolean }[]>;
  /** 注册并登录一个新用户，默认开启自动调度 */
  user(email?: string, options?: { autoDispatch?: boolean }): Promise<Client>;
  logs(): string;
  stop(): Promise<void>;
}

let userSeq = 0;

export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const operatorPort = await freePort();
  const fake: Server = await startFakeOperator(operatorPort);
  const operator = `http://127.0.0.1:${operatorPort}`;
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-test-'));
  let output = '';

  const child: ChildProcess = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/index.ts'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        MEDIA_DIR: '',
        PROVIDER: 'comfyweb',
        GEN_API_BASE: operator,
        COMFY_APPID: 'dev',
        COMFY_SECRET: 'dev',
        COMFY_IMAGE_POLL_MS: '150',
        COMFY_VIDEO_POLL_MS: '150',
        SCHEDULER_TICK_MS: '100',
        HEALTH_TTL_MS: '200',
        MAX_RUNNING: '4',
        LLM_API_BASE: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`织影服务启动失败：\n${output}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) break;
    } catch {
      // 还没起来
    }
    if (Date.now() > deadline) throw new Error(`织影服务启动超时：\n${output}`);
    await sleep(100);
  }

  return {
    base,
    operator,
    dataDir,
    pid: child.pid!,
    async scenario(patch) {
      await fetch(`${operator}/__control`, { method: 'POST', body: JSON.stringify(patch) });
    },
    async operatorRequests() {
      return (await fetch(`${operator}/__requests`)).json() as never;
    },
    async user(email, options = {}) {
      const client = new Client(base);
      await client.post('/api/auth/register', {
        email: email ?? `u${++userSeq}-${port}@test.local`,
        password: 'password123',
        name: '测试',
      });
      await client.patch('/api/settings', { autoDispatch: options.autoDispatch !== false, pollIntervalSec: 5 });
      return client;
    },
    logs: () => output,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => (child.exitCode !== null ? resolve(null) : child.once('exit', resolve)));
      await new Promise((resolve) => fake.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询直到条件成立 */
export async function until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, label = '条件'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`等待${label}超时${last ? `：${String(last)}` : ''}`);
    await sleep(100);
  }
}

export const IMAGE_PARAMS = {
  aspectRatio: '1:1',
  resolution: '1K',
  width: 1024,
  height: 1024,
  count: 1,
  seed: null,
};

export const VIDEO_PARAMS = {
  aspectRatio: '16:9',
  resolution: '720p',
  width: 1344,
  height: 768,
  count: 1,
  seed: null,
  duration: 5,
};
