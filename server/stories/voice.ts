// 台词配音（EXP-08）：逐句调用 TTS（未配置时模拟配音），存成音频素材（purpose=voice），写回台词的 voiceAssetId。
// 作为 fast 通道的后台作业运行，进度推送给编辑器；已有配音的台词默认跳过。
import type { StoryOp } from '../../shared/story-ops.ts';
import { db } from '../db.ts';
import { saveAsset } from '../files.ts';
import { registerJobKind } from '../jobs/runner.ts';
import { synthesize } from '../providers/tts.ts';
import { commitOps } from '../routes/stories.ts';
import { loadStory } from './store.ts';

export interface VoicePayload {
  storyId: string;
  userId: string;
  /** 只配这些台词；不填配全部 */
  lineIds?: string[];
  /** 已有配音的也重新生成 */
  overwrite?: boolean;
}

export function voiceTargets(storyId: string, payload: Pick<VoicePayload, 'lineIds' | 'overwrite'>) {
  const { data } = loadStory(storyId);
  const wanted = payload.lineIds ? new Set(payload.lineIds) : null;
  const voices = new Map(data.characters.map((c) => [c.id, c.voice ?? null]));
  const out: { lineId: string; text: string; emotion: string; voice: string | null }[] = [];
  for (const chapter of data.chapters)
    for (const scene of chapter.scenes)
      for (const line of scene.dialogue) {
        if (wanted && !wanted.has(line.id)) continue;
        if (line.kind === 'caption' || !line.text.trim()) continue;
        if (line.voiceAssetId && !payload.overwrite) continue;
        out.push({ lineId: line.id, text: line.text.trim(), emotion: line.emotion, voice: line.characterId ? (voices.get(line.characterId) ?? null) : null });
      }
  return out;
}

export function registerVoiceJob(): void {
  registerJobKind<VoicePayload>('story-voice', {
    maxAttempts: 1,
    handler: async (ctx) => {
      const { storyId, userId } = ctx.payload;
      const targets = voiceTargets(storyId, ctx.payload);
      let done = 0;
      let mock = false;
      for (const target of targets) {
        if (ctx.signal.aborted) break;
        ctx.progress(done / Math.max(1, targets.length), `配音 ${done + 1}/${targets.length}`);
        const speech = await synthesize(target.text, { voice: target.voice, emotion: target.emotion, signal: ctx.signal });
        mock ||= speech.mock;
        const asset = await saveAsset({
          userId,
          kind: 'audio',
          source: 'generated',
          mime: speech.mime,
          data: speech.data,
          storyId,
          purpose: 'voice',
          prompt: target.text,
          filename: `配音-${target.text.slice(0, 12)}.${speech.mime === 'audio/wav' ? 'wav' : 'mp3'}`,
          meta: { voice: { lineId: target.lineId, mock: speech.mock, voice: target.voice }, aigc: true },
        });
        if (speech.duration) db.prepare('UPDATE assets SET duration = ? WHERE id = ?').run(speech.duration, asset.id);
        const op: StoryOp = { op: 'set', entity: 'line', id: target.lineId, patch: { voiceAssetId: asset.id } };
        commitOps(storyId, userId, [op], null);
        done++;
      }
      return { count: done, mock };
    },
  });
}
