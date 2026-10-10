// OpenAI 兼容的对话接口（/v1/chat/completions）。
// 朋友的 ComfyUI Web API 没有语言模型接口，AI 写作助手单独走这里，
// vLLM、Ollama、LM Studio、各家云 API 都提供这种格式。
import { config } from '../config.ts';
import { ProviderUnavailableError, type ChatMessage, type ChatOptions } from './types.ts';

export function llmConfigured(): boolean {
  return Boolean(config.llmApiBase && config.llmModel);
}

function endpoint(): string {
  // 兼容填写到 /v1 或只填到域名两种写法
  return config.llmApiBase.endsWith('/v1') ? `${config.llmApiBase}/chat/completions` : `${config.llmApiBase}/v1/chat/completions`;
}

export async function openAiChat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
  if (!llmConfigured()) throw new ProviderUnavailableError('尚未配置语言模型（LLM_API_BASE / LLM_MODEL）');
  let response: Response;
  try {
    response = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.llmApiKey ? { authorization: `Bearer ${config.llmApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages,
        temperature: options.temperature ?? 0.8,
        ...(options.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    throw new ProviderUnavailableError(`无法连接语言模型：${(error as Error).message}`);
  }
  const text = await response.text();
  if (response.status >= 500 || response.status === 429) throw new ProviderUnavailableError(`语言模型繁忙（HTTP ${response.status}）`);
  if (!response.ok) throw new Error(`语言模型返回错误（HTTP ${response.status}）：${text.slice(0, 300)}`);
  const data = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('语言模型没有返回内容');
  return content;
}

/** 轻量连通性检查：能列出模型即视为可用 */
export async function llmHealthy(): Promise<boolean> {
  if (!llmConfigured()) return false;
  const base = config.llmApiBase.endsWith('/v1') ? config.llmApiBase : `${config.llmApiBase}/v1`;
  try {
    const response = await fetch(`${base}/models`, {
      headers: config.llmApiKey ? { authorization: `Bearer ${config.llmApiKey}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    // 有些服务不实现 /models，只要不是连接失败或 5xx 就算在线
    return response.status < 500;
  } catch {
    return false;
  }
}
