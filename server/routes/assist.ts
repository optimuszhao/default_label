// AI 创作助手：写作（大纲 / 角色 / 章节 / 台词 / 分镜）和提示词辅助（润色 / 扩写 / 翻译 / 变体 / 填变量 / 动作建议 / 灵感）
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ASSIST_KINDS, type AssistKind } from '../../shared/types.ts';
import { offlineInspire, runAssist } from '../assist.ts';
import { getHealth } from '../providers/index.ts';
import { bad, uid } from './common.ts';
import { ownedStory, snapshotStory } from './stories.ts';

/** 每个用户 10 分钟内最多 30 次 */
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT = 30;
const calls = new Map<string, number[]>();

function allow(userId: string): boolean {
  const now = Date.now();
  const recent = (calls.get(userId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    calls.set(userId, recent);
    return false;
  }
  recent.push(now);
  calls.set(userId, recent);
  return true;
}

/** 提示词类请求按输入做 LRU 缓存（同样的输入不重复调用模型） */
const CACHEABLE = new Set<AssistKind>(['polish', 'expand', 'translate', 'motion']);
const cache = new Map<string, Record<string, unknown>>();
const CACHE_SIZE = 200;

export async function assistRoutes(api: FastifyInstance): Promise<void> {
  api.post('/api/assist/:kind', async (request, reply) => {
    const { kind } = request.params as { kind: AssistKind };
    if (!ASSIST_KINDS.includes(kind)) return bad(reply, '未知的助手类型', 404);
    // storyId 只用于留历史版本，不发给语言模型
    const { storyId, ...input } = (request.body ?? {}) as Record<string, unknown>;

    const health = await getHealth();
    if (!health.llm) {
      // 随机灵感在没有语言模型时改用离线词库
      if (kind === 'inspire') return offlineInspire(input.mode);
      return bad(reply, '语言模型服务暂不可用，请稍后再试', 503);
    }
    if (!allow(uid(request))) return bad(reply, 'AI 助手调用太频繁了，请过几分钟再试（每 10 分钟最多 30 次）', 429);

    // 故事里的 AI 改写会替换已有内容：先留一份历史版本
    if (typeof storyId === 'string' && ['outline', 'characters', 'chapters', 'dialogue', 'shots'].includes(kind)) {
      const story = ownedStory(request, storyId);
      if (story) snapshotStory(story, `ai:${kind}`);
    }

    const key = CACHEABLE.has(kind) ? createHash('sha256').update(`${kind}:${JSON.stringify(input)}`).digest('hex') : null;
    if (key && cache.has(key)) {
      const hit = cache.get(key)!;
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    try {
      const result = await runAssist(kind, input);
      if (key) {
        cache.set(key, result);
        if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
      }
      return result;
    } catch (error) {
      return bad(reply, `AI 助手调用失败：${(error as Error).message}`, 502);
    }
  });
}
