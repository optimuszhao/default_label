// 旧故事（整篇 JSON，schema=1）迁移到拆表（schema=2）：
//   1. 打开故事时立即迁移这一个；其余的由后台作业逐个迁移
//   2. 保留全部原 id（assets.shot_id / tasks.shot_id 不用改）
//   3. 写完立刻读回，和原 JSON 逐项比对；不一致就整体回滚，保持 schema=1 并以只读方式打开
//   4. 成功后留一份 migration 快照（原始 JSON，永久保留）
import type { StoryData } from '../../shared/types.ts';
import { db, now, parseJson, type Row } from '../db.ts';
import { enqueueJob, registerJobKind } from '../jobs/runner.ts';
import { logger } from '../log.ts';
import { defaultData, loadStory, writeStory } from './store.ts';

const str = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value));
const arr = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** 旧数据补齐默认值（老版本可能缺字段） */
export function normalizeLegacy(raw: unknown): StoryData {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const base = defaultData();
  return {
    logline: str(d.logline),
    genre: str(d.genre),
    tone: str(d.tone),
    visualStyle: d.visualStyle == null ? base.visualStyle : str(d.visualStyle),
    aspectRatio: str(d.aspectRatio) || '16:9',
    outline: str(d.outline),
    ...(d.negativePrompt ? { negativePrompt: str(d.negativePrompt) } : {}),
    characters: arr<Record<string, unknown>>(d.characters).map((c) => ({
      id: str(c.id),
      name: str(c.name),
      role: str(c.role),
      appearance: str(c.appearance),
      personality: str(c.personality),
      referenceAssetId: (c.referenceAssetId as string | null) ?? null,
    })),
    elements: [],
    chapters: arr<Record<string, unknown>>(d.chapters).map((ch) => ({
      id: str(ch.id),
      title: str(ch.title),
      summary: str(ch.summary),
      scenes: arr<Record<string, unknown>>(ch.scenes).map((sc) => ({
        id: str(sc.id),
        title: str(sc.title),
        location: str(sc.location),
        time: str(sc.time),
        summary: str(sc.summary),
        dialogue: arr<Record<string, unknown>>(sc.dialogue).map((l) => ({
          id: str(l.id),
          characterId: (l.characterId as string | null) ?? null,
          text: str(l.text),
          emotion: str(l.emotion),
        })),
        shots: arr<Record<string, unknown>>(sc.shots).map((sh) => ({
          id: str(sh.id),
          shotSize: str(sh.shotSize),
          cameraMove: str(sh.cameraMove),
          description: str(sh.description),
          dialogueIds: arr<string>(sh.dialogueIds),
          duration: Number(sh.duration) || 5,
          characterIds: arr<string>(sh.characterIds),
          keyframeAssetId: (sh.keyframeAssetId as string | null) ?? null,
          videoAssetId: (sh.videoAssetId as string | null) ?? null,
        })),
      })),
    })),
  };
}

/** 比对用的投影：只比较旧格式里有的字段 */
function projection(data: StoryData): unknown {
  return {
    logline: data.logline,
    genre: data.genre,
    tone: data.tone,
    visualStyle: data.visualStyle,
    aspectRatio: data.aspectRatio,
    outline: data.outline,
    negativePrompt: data.negativePrompt ?? '',
    characters: data.characters.map((c) => [c.id, c.name, c.role, c.appearance, c.personality, c.referenceAssetId ?? null]),
    chapters: data.chapters.map((ch) => [
      ch.id,
      ch.title,
      ch.summary,
      ch.scenes.map((sc) => [
        sc.id,
        sc.title,
        sc.location,
        sc.time,
        sc.summary,
        sc.dialogue.map((l) => [l.id, l.characterId ?? null, l.text, l.emotion]),
        sc.shots.map((sh) => [sh.id, sh.shotSize, sh.cameraMove, sh.description, sh.dialogueIds, sh.duration, [...sh.characterIds].sort(), sh.keyframeAssetId ?? null, sh.videoAssetId ?? null]),
      ]),
    ]),
  };
}

/** 同一篇故事里重复的 id（老版本的 bug 可能造成）：后出现的换成新 id，避免写表时互相覆盖 */
function dedupeIds(data: StoryData): StoryData {
  const seen = new Set<string>();
  const fresh = (id: string, prefix: string) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      return id;
    }
    let next = `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
    while (seen.has(next)) next += 'x';
    seen.add(next);
    return next;
  };
  for (const c of data.characters) c.id = fresh(c.id, 'c_');
  for (const ch of data.chapters) {
    ch.id = fresh(ch.id, 'ch_');
    for (const sc of ch.scenes) {
      sc.id = fresh(sc.id, 'sc_');
      for (const l of sc.dialogue) l.id = fresh(l.id, 'd_');
      for (const sh of sc.shots) sh.id = fresh(sh.id, 'sh_');
    }
  }
  return data;
}

export type MigrateResult = { ok: true } | { ok: false; error: string };

export function migrateStory(storyId: string): MigrateResult {
  const row = db.prepare('SELECT * FROM stories WHERE id = ?').get(storyId) as Row | undefined;
  if (!row) return { ok: false, error: '故事不存在' };
  if (Number(row.schema) === 2) return { ok: true };
  const original = String(row.data);
  const legacy = dedupeIds(normalizeLegacy(parseJson<unknown>(original, {})));
  const expected = JSON.stringify(projection(legacy));
  try {
    db.exec('BEGIN IMMEDIATE');
    // 迁移前的原始 JSON 永久保留
    db.prepare("INSERT INTO story_snapshots (id, story_id, rev, title, data, reason, label, pinned, created_at) VALUES (?, ?, ?, ?, ?, 'migration', '升级前的原始内容', 1, ?)").run(
      `ss_mig_${storyId}`,
      storyId,
      Number(row.rev ?? 0),
      String(row.title),
      original,
      now(),
    );
    writeStory(storyId, String(row.user_id), String(row.title), legacy);
    const loaded = loadStory(storyId);
    const actual = JSON.stringify(projection(loaded.data));
    if (actual !== expected) throw new Error('读回校验不一致');
    db.prepare('UPDATE stories SET schema = 2, rev = rev + 1, migrate_error = NULL WHERE id = ?').run(storyId);
    db.exec('COMMIT');
    return { ok: true };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 没有进行中的事务
    }
    const message = (error as Error).message;
    db.prepare('UPDATE stories SET migrate_error = ? WHERE id = ?').run(message, storyId);
    logger.error({ storyId, err: message }, '故事迁移失败，以只读方式打开');
    return { ok: false, error: message };
  }
}

/** 后台逐个迁移：每次一个，隔 2 秒再来，不和用户抢数据库 */
export function registerStoryMigrationJob(): void {
  registerJobKind('story-migrate', {
    maxAttempts: 1,
    handler: async () => {
      const row = db.prepare('SELECT id FROM stories WHERE schema = 1 AND migrate_error IS NULL ORDER BY updated_at DESC LIMIT 1').get() as Row | undefined;
      if (!row) return { done: true };
      const result = migrateStory(String(row.id));
      enqueueJob('story-migrate', {}, { dedupeKey: 'story-migrate', runAfter: now() + 2000 });
      return { storyId: row.id, ...result };
    },
  });
}

export function startStoryMigration(): void {
  const pending = db.prepare('SELECT COUNT(*) AS n FROM stories WHERE schema = 1 AND migrate_error IS NULL').get() as Row;
  if (Number(pending.n) > 0) enqueueJob('story-migrate', {}, { dedupeKey: 'story-migrate' });
}
