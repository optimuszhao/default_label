import path from 'node:path';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const root = process.cwd();

export const config = {
  port: num('PORT', 8787),
  host: process.env.HOST ?? '0.0.0.0',
  isProd: process.env.NODE_ENV === 'production',
  dataDir: path.resolve(root, process.env.DATA_DIR ?? 'data'),
  webDist: path.resolve(root, 'dist'),

  /**
   * 生成服务适配器：
   * - mock：本地模拟，不需要 GPU，方便开发界面
   * - http：对接同事在 ComfyUI 上暴露的接口，协议见 docs/API_CONTRACT.md
   */
  provider: (process.env.PROVIDER ?? 'mock') as 'mock' | 'http',
  genApiBase: (process.env.GEN_API_BASE ?? '').replace(/\/+$/, ''),
  genApiKey: process.env.GEN_API_KEY ?? '',
  /** mock 模式下模拟服务时好时坏 */
  mockFlaky: process.env.MOCK_FLAKY === '1',

  /** 调度器节拍 */
  schedulerTickMs: num('SCHEDULER_TICK_MS', 2000),
  /** 健康检查缓存时间 */
  healthTtlMs: num('HEALTH_TTL_MS', 10000),
  /** 同时在生成服务上运行的任务数（单张 5090 建议 1~2） */
  maxRunning: num('MAX_RUNNING', 1),
  /** 单个任务默认最多重试次数 */
  maxAttempts: num('MAX_ATTEMPTS', 3),
  /** 单个任务最长运行时间，超时视为失败 */
  jobTimeoutMs: num('JOB_TIMEOUT_MS', 30 * 60 * 1000),

  sessionDays: num('SESSION_DAYS', 30),
  cookieSecure: process.env.COOKIE_SECURE === '1',
  maxUploadMb: num('MAX_UPLOAD_MB', 20),
};
