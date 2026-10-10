import type { ProviderHealth } from '../../shared/types.ts';
import { config } from '../config.ts';
import { ComfyWebProvider } from './comfyweb.ts';
import { HttpProvider } from './http.ts';
import { MockProvider } from './mock.ts';
import type { Provider } from './types.ts';

function createProvider(): Provider {
  switch (config.provider) {
    case 'http':
      return new HttpProvider();
    case 'comfyweb':
      return new ComfyWebProvider();
    default:
      return new MockProvider();
  }
}

export const provider: Provider = createProvider();

let cached: ProviderHealth | null = null;
let inflight: Promise<ProviderHealth> | null = null;

/** 带缓存的健康检查，避免每个调度节拍都去打生成服务 */
export async function getHealth(force = false): Promise<ProviderHealth> {
  if (!force && cached && Date.now() - cached.checkedAt < config.healthTtlMs) return cached;
  inflight ??= provider
    .health()
    .then((result) => {
      cached = { provider: provider.name, ...result, checkedAt: Date.now() };
      return cached;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 提交失败时立刻把对应能力标记为不可用，直到下次健康检查 */
export function markUnavailable(capability: 'image' | 'video' | 'llm', message: string): void {
  if (!cached) return;
  cached = { ...cached, [capability]: false, message };
}

export * from './types.ts';
