// 配置集中在这里读取并校验：环境变量写错时启动直接失败，并用中文指出哪一项有问题，
// 而不是带着错误配置跑起来、到生成时才报莫名其妙的错。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const root = process.cwd();
const env = process.env;

/** 空字符串视为未填写（.env 里写了 KEY= 但没给值） */
const blank = (value: string | undefined) => (value === undefined || value.trim() === '' ? undefined : value.trim());

const intIn = (name: string, min: number, max: number, fallback: number) =>
  z.preprocess(
    (value) => (blank(value as string | undefined) === undefined ? fallback : Number(value)),
    z
      .number({ error: `${name} 必须是数字` })
      .int(`${name} 必须是整数`)
      .min(min, `${name} 不能小于 ${min}`)
      .max(max, `${name} 不能大于 ${max}`),
  );

const httpUrl = (name: string) =>
  z
    .string()
    .transform((value) => value.replace(/\/+$/, ''))
    .refine((value) => value === '' || /^https?:\/\/[^\s/]+/i.test(value), `${name} 必须是 http:// 或 https:// 开头的地址`);

function readVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const schema = z
  .object({
    port: intIn('PORT', 1, 65535, 8787),
    host: z.string().default('0.0.0.0'),
    nodeEnv: z.string().default('development'),
    dataDir: z.string(),
    mediaDir: z.string(),
    provider: z.enum(['mock', 'http', 'comfyweb'], { error: 'PROVIDER 只能是 mock、http 或 comfyweb' }),
    genApiBase: httpUrl('GEN_API_BASE'),
    genApiKey: z.string(),
    comfyAppId: z.string(),
    comfySecret: z.string(),
    comfyToken: z.string(),
    comfyEmail: z.string(),
    comfyPassword: z.string(),
    comfyImagePollMs: intIn('COMFY_IMAGE_POLL_MS', 100, 600_000, 4000),
    comfyVideoPollMs: intIn('COMFY_VIDEO_POLL_MS', 100, 600_000, 12000),
    llmApiBase: httpUrl('LLM_API_BASE'),
    llmApiKey: z.string(),
    llmModel: z.string(),
    mockFlaky: z.boolean(),
    llmMock: z.boolean(),
    schedulerTickMs: intIn('SCHEDULER_TICK_MS', 50, 60_000, 2000),
    healthTtlMs: intIn('HEALTH_TTL_MS', 100, 600_000, 10000),
    maxRunning: intIn('MAX_RUNNING', 1, 32, 2),
    maxAttempts: intIn('MAX_ATTEMPTS', 1, 20, 3),
    jobTimeoutMs: intIn('JOB_TIMEOUT_MS', 60_000, 24 * 3600_000, 30 * 60_000),
    videoJobTimeoutMs: intIn('VIDEO_JOB_TIMEOUT_MS', 60_000, 24 * 3600_000, 90 * 60_000),
    adminEmails: z.array(z.string().email('ADMIN_EMAILS 里有格式不对的邮箱')),
    registration: z.enum(['open', 'closed'], { error: 'REGISTRATION 只能是 open 或 closed' }),
    sessionDays: intIn('SESSION_DAYS', 1, 3650, 30),
    cookieSecure: z.boolean(),
    maxUploadMb: intIn('MAX_UPLOAD_MB', 1, 2048, 20),
    uploadMaxMb: intIn('UPLOAD_MAX_MB', 1, 20480, 2048),
    trashDays: intIn('TRASH_DAYS', 1, 3650, 30),
    idleWindow: z
      .string()
      .refine((value) => /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(value), 'IDLE_WINDOW 格式应为 HH:mm-HH:mm，例如 01:00-07:00'),
    ttsApiBase: httpUrl('TTS_API_BASE'),
    ttsApiKey: z.string(),
    ttsModel: z.string(),
    ttsVoice: z.string(),
    logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], {
      error: 'LOG_LEVEL 只能是 fatal / error / warn / info / debug / trace / silent',
    }),
    /** 每天自动备份数据库的时间（本地时间 HH:mm），留空则不备份 */
    backupAt: z
      .string()
      .refine((value) => value === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(value), 'BACKUP_AT 格式应为 HH:mm，例如 03:30'),
    backupKeep: intIn('BACKUP_KEEP', 1, 365, 7),
    appVersion: z.string(),
    gitSha: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.provider !== 'mock' && !value.genApiBase) {
      ctx.addIssue({ code: 'custom', message: `PROVIDER=${value.provider} 时必须填写 GEN_API_BASE（生成服务地址）`, path: ['genApiBase'] });
    }
  });

const dataDir = path.resolve(root, blank(env.DATA_DIR) ?? 'data');

const raw = {
  port: env.PORT,
  host: blank(env.HOST),
  nodeEnv: blank(env.NODE_ENV),
  dataDir,
  /** 生成的图片、视频和上传素材存放目录，默认在 DATA_DIR/files，可单独指向 NAS 的大容量磁盘 */
  mediaDir: path.resolve(root, blank(env.MEDIA_DIR) ?? path.join(dataDir, 'files')),
  /**
   * 生成服务适配器：
   * - mock：本地模拟，不需要 GPU，方便开发界面
   * - http：按 docs/API_CONTRACT.md 实现的通用接口
   * - comfyweb：朋友的「ComfyUI Web API」
   */
  provider: blank(env.PROVIDER) ?? 'mock',
  genApiBase: blank(env.GEN_API_BASE) ?? '',
  genApiKey: blank(env.GEN_API_KEY) ?? '',
  /** comfyweb：对方分配的 API ID + 密钥，用于换取 token（有效期 72 小时，过期自动重新登录） */
  comfyAppId: blank(env.COMFY_APPID) ?? '',
  comfySecret: blank(env.COMFY_SECRET) ?? '',
  /** 也可以直接给一个现成的 token（调试用） */
  comfyToken: blank(env.COMFY_TOKEN) ?? '',
  /** 旧版邮箱账号登录，新版接口已不再使用，仅作兼容 */
  comfyEmail: blank(env.COMFY_EMAIL) ?? '',
  comfyPassword: blank(env.COMFY_PASSWORD) ?? '',
  /** 查询任务进度的间隔：对方建议图片 3–5 秒、视频 10–15 秒 */
  comfyImagePollMs: env.COMFY_IMAGE_POLL_MS,
  comfyVideoPollMs: env.COMFY_VIDEO_POLL_MS,
  /** 语言模型（AI 写大纲 / 台词 / 分镜），任何 OpenAI 兼容的 /v1/chat/completions 接口 */
  llmApiBase: blank(env.LLM_API_BASE) ?? '',
  llmApiKey: blank(env.LLM_API_KEY) ?? '',
  llmModel: blank(env.LLM_MODEL) ?? '',
  /** mock 模式下模拟服务时好时坏 */
  mockFlaky: env.MOCK_FLAKY === '1',
  /** 没有语言模型时用模板化的模拟写作助手（先体验故事流程，效果不代表真实模型） */
  llmMock: env.LLM_MOCK === '1',
  schedulerTickMs: env.SCHEDULER_TICK_MS,
  healthTtlMs: env.HEALTH_TTL_MS,
  /** 同时提交给生成服务的任务数；对方在 ComfyUI 内部排队，2 可以让图片不必等长视频 */
  maxRunning: env.MAX_RUNNING,
  maxAttempts: env.MAX_ATTEMPTS,
  /** 图片任务最长运行时间 */
  jobTimeoutMs: env.JOB_TIMEOUT_MS,
  /** 视频任务最长运行时间：含转码和 2x 超分，单条通常 15–30 分钟 */
  videoJobTimeoutMs: env.VIDEO_JOB_TIMEOUT_MS,
  /** 超级管理员邮箱（逗号分隔） */
  adminEmails: (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
  /** 注册开关：open 开放注册；closed 关闭（ADMIN_EMAILS 里的邮箱仍可注册） */
  registration: blank(env.REGISTRATION) ?? 'open',
  sessionDays: env.SESSION_DAYS,
  cookieSecure: env.COOKIE_SECURE === '1',
  maxUploadMb: env.MAX_UPLOAD_MB,
  /** 资产库分片上传的单文件上限（MB），默认 2 GB */
  uploadMaxMb: env.UPLOAD_MAX_MB,
  /** 回收站保留天数，到期自动彻底删除 */
  trashDays: env.TRASH_DAYS,
  /** 闲时时段：批量生成勾选"闲时生成"后，任务在这个时段才开始派发 */
  idleWindow: blank(env.IDLE_WINDOW) ?? '01:00-07:00',
  /** 配音（TTS）：任何 OpenAI 兼容的 /v1/audio/speech 接口；不配置时用模拟配音 */
  ttsApiBase: blank(env.TTS_API_BASE) ?? '',
  ttsApiKey: blank(env.TTS_API_KEY) ?? '',
  ttsModel: blank(env.TTS_MODEL) ?? '',
  ttsVoice: blank(env.TTS_VOICE) ?? '',
  logLevel: blank(env.LOG_LEVEL) ?? (env.NODE_ENV === 'test' ? 'warn' : 'info'),
  backupAt: env.BACKUP_AT === undefined ? '03:30' : env.BACKUP_AT.trim(),
  backupKeep: env.BACKUP_KEEP,
  /** 构建时由 Docker 注入；本地运行时取 package.json 的版本 */
  appVersion: blank(env.APP_VERSION) ?? readVersion(),
  gitSha: blank(env.GIT_SHA) ?? '',
};

function load() {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => `  · ${issue.message}`);
  console.error(`[weave] 配置有误，服务没有启动：\n${lines.join('\n')}\n请检查 .env 或 docker-compose.yml 里的环境变量（说明见 README「配置」一节）。`);
  process.exit(1);
}

const parsed = load();

export const config = {
  ...parsed,
  isProd: parsed.nodeEnv === 'production',
  webDist: path.resolve(root, 'dist'),
};
