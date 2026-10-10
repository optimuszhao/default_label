// AI 写作助手
import type { FastifyInstance } from 'fastify';
import type { AssistKind } from '../../shared/types.ts';
import { runAssist } from '../assist.ts';
import { getHealth } from '../providers/index.ts';
import { bad } from './common.ts';
import { ownedStory, snapshotStory } from './stories.ts';

export async function assistRoutes(api: FastifyInstance): Promise<void> {
  api.post('/api/assist/:kind', async (request, reply) => {
    const { kind } = request.params as { kind: AssistKind };
    if (!['polish', 'outline', 'characters', 'chapters', 'dialogue', 'shots'].includes(kind)) {
      return bad(reply, '未知的助手类型', 404);
    }
    const health = await getHealth();
    if (!health.llm) return bad(reply, '语言模型服务暂不可用，请稍后再试', 503);
    // 故事里的 AI 改写会替换已有内容：先留一份历史版本
    const storyId = (request.body as { storyId?: unknown } | null)?.storyId;
    if (typeof storyId === 'string' && kind !== 'polish') {
      const story = ownedStory(request, storyId);
      if (story) snapshotStory(story, `ai:${kind}`);
    }
    try {
      // storyId 只用于留历史版本，不发给语言模型
      const { storyId: _storyId, ...input } = (request.body ?? {}) as Record<string, unknown>;
      return await runAssist(kind, input);
    } catch (error) {
      return bad(reply, `AI 助手调用失败：${(error as Error).message}`, 502);
    }
  });
}
