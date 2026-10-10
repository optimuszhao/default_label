// 对接同事在 5090 + ComfyUI 上暴露的 HTTP 接口。
// 接口协议见 docs/API_CONTRACT.md —— 他那边按协议实现，这边就不用再改业务代码。
// 如果最终接口和协议不一致，只需要改这个文件。
import fs from 'node:fs/promises';
import {
  ProviderUnavailableError,
  type JobStatus,
  type OperatorContext,
  type OperatorHealth,
  type Provider,
  type SubmitInput,
} from './types.ts';

async function request<T>(ctx: OperatorContext, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  if (!ctx.baseUrl) {
    throw new ProviderUnavailableError('算子没有配置服务地址');
  }
  const apiKey = ctx.secret('apiKey');
  let response: Response;
  try {
    response = await fetch(`${ctx.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ProviderUnavailableError(`无法连接生成服务：${(error as Error).message}`);
  }
  const text = await response.text();
  if (response.status >= 500 || response.status === 429) {
    throw new ProviderUnavailableError(`生成服务繁忙或异常（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    throw new Error(`生成服务返回错误（HTTP ${response.status}）：${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export class HttpProvider implements Provider {
  readonly kind = 'http';
  readonly name: string;
  private readonly ctx: OperatorContext;

  constructor(ctx: OperatorContext) {
    this.ctx = ctx;
    this.name = ctx.name;
  }

  async health(): Promise<OperatorHealth> {
    try {
      const result = await request<{ image?: boolean; video?: boolean; message?: string }>(
        this.ctx,
        'GET',
        '/health',
        undefined,
        5_000,
      );
      return {
        image: Boolean(result.image),
        video: Boolean(result.video),
        message: result.message,
      };
    } catch (error) {
      return { image: false, video: false, message: (error as Error).message };
    }
  }

  async submit(input: SubmitInput) {
    const images = await Promise.all(
      input.images.map(async (image) => ({
        role: image.role,
        mime: image.mime,
        data_base64: (await fs.readFile(image.path)).toString('base64'),
      })),
    );
    const result = await request<{ job_id: string }>(this.ctx, 'POST', '/v1/jobs', {
      client_task_id: input.taskId,
      type: input.type,
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      params: {
        aspect_ratio: input.params.aspectRatio,
        resolution: input.params.resolution,
        width: input.params.width,
        height: input.params.height,
        count: input.params.count,
        seed: input.params.seed,
        steps: input.params.steps,
        cfg: input.params.cfg,
        strength: input.params.strength,
        duration: input.params.duration,
        fps: input.params.fps,
        camera_motion: input.params.cameraMotion,
        model: input.params.model,
      },
      images,
    });
    return { jobId: result.job_id };
  }

  async poll(jobId: string): Promise<JobStatus> {
    const result = await request<{
      state: JobStatus['state'];
      progress?: number;
      error?: string;
      outputs?: { kind: 'image' | 'video'; mime: string; url?: string; base64?: string; width?: number; height?: number }[];
    }>(this.ctx, 'GET', `/v1/jobs/${encodeURIComponent(jobId)}`, undefined, 15_000);
    return {
      state: result.state,
      progress: result.progress,
      error: result.error,
      outputs: result.outputs?.map((output) => ({
        ...output,
        // 相对地址按服务根路径补全
        url: output.url && output.url.startsWith('/') ? `${this.ctx.baseUrl}${output.url}` : output.url,
      })),
    };
  }

  async cancel(jobId: string) {
    await request(this.ctx, 'POST', `/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {});
  }
}
