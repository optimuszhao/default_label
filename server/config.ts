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
  /** 数据库所在目录 */
  dataDir: path.resolve(root, process.env.DATA_DIR || 'data'),
  /** 生成的图片、视频和上传素材存放目录，默认在 DATA_DIR/files，可单独指向 NAS 的大容量磁盘 */
  // 用 || 而不是 ??：.env 里留空（MEDIA_DIR=）时也回落到默认值
  mediaDir: path.resolve(root, process.env.MEDIA_DIR || path.join(process.env.DATA_DIR || 'data', 'files')),
  webDist: path.resolve(root, 'dist'),

  /**
   * 生成服务适配器：
   * - mock：本地模拟，不需要 GPU，方便开发界面
   * - http：对接同事在 ComfyUI 上暴露的接口，协议见 docs/API_CONTRACT.md
   */
  provider: (process.env.PROVIDER || 'mock') as 'mock' | 'http' | 'comfyweb',
  genApiBase: (process.env.GEN_API_BASE ?? '').replace(/\/+$/, ''),
  genApiKey: process.env.GEN_API_KEY ?? '',
  /** PROVIDER=comfyweb：对方分配的 API ID + 密钥，用于换取 token（有效期 72 小时，过期自动重新登录） */
  comfyAppId: process.env.COMFY_APPID ?? '',
  comfySecret: process.env.COMFY_SECRET ?? '',
  /** 也可以直接给一个现成的 token（调试用） */
  comfyToken: process.env.COMFY_TOKEN ?? '',
  /** 旧版邮箱账号登录，新版接口已不再使用，仅作兼容 */
  comfyEmail: process.env.COMFY_EMAIL ?? '',
  comfyPassword: process.env.COMFY_PASSWORD ?? '',
  /** 查询任务进度的间隔：对方建议图片 3–5 秒、视频 10–15 秒 */
  comfyImagePollMs: num('COMFY_IMAGE_POLL_MS', 4000),
  comfyVideoPollMs: num('COMFY_VIDEO_POLL_MS', 12000),

  /**
   * 语言模型（AI 写大纲 / 台词 / 分镜）。任何 OpenAI 兼容的 /v1/chat/completions 接口都可以，
   * 例如 vLLM、Ollama、LM Studio、各家云 API。不配置时 AI 助手显示为不可用（mock 模式除外）。
   */
  llmApiBase: (process.env.LLM_API_BASE ?? '').replace(/\/+$/, ''),
  llmApiKey: process.env.LLM_API_KEY ?? '',
  llmModel: process.env.LLM_MODEL ?? '',

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
  /** 单个图片任务最长运行时间，超时视为失败 */
  jobTimeoutMs: num('JOB_TIMEOUT_MS', 30 * 60 * 1000),
  /** 视频任务最长运行时间：含转码和 2x 超分，单条通常 15–30 分钟，排队时更久 */
  videoJobTimeoutMs: num('VIDEO_JOB_TIMEOUT_MS', 90 * 60 * 1000),

  sessionDays: num('SESSION_DAYS', 30),
  cookieSecure: process.env.COOKIE_SECURE === '1',
  maxUploadMb: num('MAX_UPLOAD_MB', 20),
};
