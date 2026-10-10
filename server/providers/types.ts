// 生成服务适配层的统一接口。
// 业务代码（调度器、AI 助手）只依赖这里的 Provider 接口，
// 具体对接 ComfyUI / MiniMax / 千问 Image / LLM 的细节都在各自的实现里。
import type { Capability, GenParams, TaskType } from '../../shared/types.ts';

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
}

export interface ProviderOutput {
  kind: 'image' | 'video';
  mime: string;
  /** 三选一：本地临时文件（推荐，大文件不进内存）、远程地址（会被下载到本地）或 base64 内容 */
  filePath?: string;
  url?: string;
  base64?: string;
  /** 这个产物实际使用的种子 */
  seed?: number;
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

export interface Provider {
  readonly name: string;
  health(): Promise<Record<Capability, boolean> & { message?: string }>;
  submit(input: SubmitInput): Promise<{ jobId: string }>;
  poll(jobId: string): Promise<JobStatus>;
  /** 两次查询之间的最短间隔（毫秒），不实现时每个调度节拍都查 */
  pollIntervalMs?(jobId: string): number;
  cancel(jobId: string): Promise<void>;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}

/** 生成服务暂时不可用（网络不通、5xx、服务未启动），调度器会稍后重试且不计入失败次数 */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
