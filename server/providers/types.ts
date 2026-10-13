// 生成服务适配层的统一接口。
// 业务代码（调度器、AI 助手）只依赖这里的 Provider 接口，
// 具体对接 ComfyUI / MiniMax / 千问 Image / LLM 的细节都在各自的实现里。
import type { Capabilities } from '../../shared/operator.ts';
import type { GenParams, TaskType, TokenStatus } from '../../shared/types.ts';

export interface ProviderImageInput {
  role: 'reference' | 'first_frame' | 'last_frame';
  mime: string;
  /** 本地文件绝对路径，适配器自行决定以 base64 还是 multipart 发送 */
  path: string;
}

export interface SubmitInput {
  taskId: string;
  type: TaskType;
  prompt: string;
  negativePrompt: string;
  params: GenParams;
  images: ProviderImageInput[];
  /** 用户锁定了种子（params.seed 是用户填的，不是调度器随机补的）：多张图要逐张可复现 */
  seedLocked?: boolean;
}

export interface ProviderOutput {
  kind: 'image' | 'video';
  mime: string;
  /** 三选一：本地临时文件（推荐，大文件不进内存）、远程地址（会被下载到本地）或 base64 内容 */
  filePath?: string;
  url?: string;
  base64?: string;
  /** 这个产物实际使用的种子 */
  /** 实际种子；null 表示无法复现（例如合并成一个任务出的第 2 张起） */
  seed?: number | null;
  width?: number;
  height?: number;
}

export interface JobStatus {
  state: 'pending' | 'running' | 'succeeded' | 'failed';
  /** 0~1 */
  progress?: number;
  /** 当前阶段的文字说明（排队中、视频生成中、超分中……），会显示在任务卡片上 */
  stage?: string;
  outputs?: ProviderOutput[];
  error?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  /** 希望模型输出 JSON */
  json?: boolean;
}

/** 单个算子实例的运行参数（来自 operators 表和加密的 secrets 表） */
export interface OperatorSettings {
  /** 查询图片 / 视频任务进度的间隔（毫秒） */
  imagePollMs: number;
  videoPollMs: number;
  /** 算子自带语言模型时用哪个模型（不填用对方默认） */
  llmModel?: string;
  /** 允许模型先"思考"再回答（更慢；默认关闭） */
  llmThink?: boolean;
}

export interface OperatorContext {
  id: string;
  name: string;
  baseUrl: string;
  appid: string;
  settings: OperatorSettings;
  /** 读取加密保存的值：secret（密钥）、apiKey、token（令牌 JSON） */
  secret(key: string): string | null;
  saveSecret(key: string, value: string | null): void;
}

export interface OperatorHealth {
  image: boolean;
  video: boolean;
  message?: string;
}

/** 算子适配器：每个算子实例一个对象，互不共享状态 */
export interface Provider {
  /** 适配器类型：comfyweb / http / mock */
  readonly kind: string;
  /** 实例名称（后台里填的名字） */
  readonly name: string;
  /** 能力声明：前端据此显示控件；不实现时用通用默认值 */
  capabilities?(): Capabilities;
  health(): Promise<OperatorHealth>;
  submit(input: SubmitInput): Promise<{ jobId: string }>;
  poll(jobId: string): Promise<JobStatus>;
  cancel(jobId: string): Promise<void>;
  /** 算子自带的语言模型（OpenAI 兼容对话）；没有时不实现 */
  chat?(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  /** 列出算子上可用的语言模型（用来判断有没有）；没有时不实现 */
  llmModels?(): Promise<string[]>;
  /** 一句场景描述 → 视频分镜提示词（算子的业务接口，按它的视频模型写法）；没有时不实现 */
  storyboard?(scene: string, duration: number): Promise<string>;
  /** 需要令牌的算子：查看状态、立即校验、重新获取、清除、手动填入、查看明文 */
  tokenStatus?(): TokenStatus;
  verifyToken?(): Promise<TokenStatus>;
  renewToken?(): Promise<TokenStatus>;
  clearToken?(): TokenStatus;
  setManualToken?(token: string): TokenStatus;
  revealToken?(): string | null;
  /** 远端最近的任务（后台排查用） */
  listRemote?(): Promise<unknown[]>;
  /** 两次查询之间的最短间隔，不实现时每个调度节拍都查 */
  pollIntervalMs?(jobId: string): number;
}

/** 生成服务暂时不可用（网络不通、5xx、服务未启动），调度器会稍后重试且不计入失败次数 */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
