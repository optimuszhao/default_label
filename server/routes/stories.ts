// 故事：列表、新建、打开（按需迁移）、增量保存（ops）、其他设备同步、历史版本、故事素材
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { StoryData, StorySnapshot, StorySummary } from '../../shared/types.ts';
import type { StoryOp } from '../../shared/story-ops.ts';
import { publish } from '../bus.ts';
import { db, newId, now, parseJson, type Row } from '../db.ts';
import { indexAsset } from '../files.ts';
import { assetUrl, toAssets } from '../repo.ts';
import { addChain, cancelChain, listChains, planBatch, runBatch, storyboardTargets, type BatchRequest } from '../stories/batch.ts';
import { ass, keyframeEntries, scriptMarkdown, scriptText, shotsCsv, srt } from '../stories/export.ts';
import { migrateStory } from '../stories/migrate.ts';
import { PassThrough } from 'node:stream';
import { writeZip } from '../media/zip.ts';
import { STORY_TEMPLATES, findTemplate } from '../../shared/story-templates.ts';
import { applyOps, defaultData, loadStory, pruneSnapshots, snapshotStory, writeStory } from '../stories/store.ts';
import { enqueueJob, getJobRow, toJob } from '../jobs/runner.ts';
import { newTempFile } from '../files.ts';
import { ttsMode } from '../providers/tts.ts';
import { filmVersions, planFilm } from '../stories/film.ts';
import { attachImportedAssets, importPackage, packageEntries, remapStoryIds } from '../stories/package.ts';
import { voiceTargets } from '../stories/voice.ts';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { bad, parse, uid } from './common.ts';

/** 每个故事保留的修订记录数（其他设备离线太久时直接重新载入整篇） */
const MAX_REVISIONS = 2000;

export function ownedStory(request: FastifyRequest, id: string): Row | undefined {
  return db.prepare('SELECT * FROM stories WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, uid(request)) as Row | undefined;
}

export { snapshotStory };

function legacyCount(row: Row): number {
  const data = parseJson<StoryData>(row.data, defaultData());
  return (data.chapters ?? []).reduce((sum, chapter) => sum + (chapter.scenes ?? []).reduce((s, scene) => s + (scene.shots ?? []).length, 0), 0);
}

/** coverIds：故事 id → 封面资产 id，列表页一次查出，避免每个故事查一次 */
function storySummary(row: Row, coverIds?: Map<string, string>): StorySummary & Record<string, unknown> {
  const schema2 = Number(row.schema) === 2;
  const settings = parseJson<Record<string, unknown>>(row.settings, {});
  const stats = parseJson<Record<string, number>>(row.stats, {});
  const coverId =
    (row.cover_asset_id as string | null) ??
    (coverIds
      ? coverIds.get(String(row.id))
      : (db.prepare("SELECT id FROM assets WHERE story_id = ? AND kind = 'image' AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1").get(String(row.id)) as Row | undefined)?.id);
  return {
    id: String(row.id),
    title: String(row.title),
    rev: Number(row.rev ?? 0),
    logline: schema2 ? String(settings.logline ?? '') : parseJson<StoryData>(row.data, defaultData()).logline ?? '',
    coverUrl: coverId ? assetUrl(String(coverId)) : null,
    shotCount: schema2 ? Number(stats.shots ?? 0) : legacyCount(row),
    status: String(row.status ?? 'active'),
    seriesId: (row.series_id as string | null) ?? null,
    episodeNo: row.episode_no == null ? null : Number(row.episode_no),
    stats: schema2 ? stats : null,
    lastOpenedAt: row.last_opened_at == null ? null : Number(row.last_opened_at),
    lastPosition: parseJson(row.last_position, null),
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
    templateId: (row.template_id as string | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** 每个故事最新一张图片作为封面 */
function coverIdsFor(userId: string): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT story_id, id FROM (
         SELECT story_id, id, ROW_NUMBER() OVER (PARTITION BY story_id ORDER BY seq DESC) AS n
         FROM assets WHERE user_id = ? AND story_id IS NOT NULL AND kind = 'image' AND deleted_at IS NULL
       ) WHERE n = 1`,
    )
    .all(userId) as Row[];
  return new Map(rows.map((row) => [String(row.story_id), String(row.id)]));
}

/** 打开故事：旧格式先迁移；迁移失败的以只读方式返回原内容 */
export function openStory(row: Row): Record<string, unknown> {
  if (Number(row.schema) !== 2) {
    const result = migrateStory(String(row.id));
    row = db.prepare('SELECT * FROM stories WHERE id = ?').get(String(row.id)) as Row;
    if (!result.ok) return { ...storySummary(row), data: parseJson<StoryData>(row.data, defaultData()), keys: {}, readOnly: true, migrateError: result.error };
  }
  const loaded = loadStory(String(row.id));
  return { ...storySummary(row), title: loaded.title, data: loaded.data, keys: loaded.keys };
}

export function createStory(userId: string, title: string, data: StoryData, extra: { templateId?: string | null; seriesId?: string | null; episodeNo?: number | null } = {}): string {
  const id = newId('s_');
  const ts = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      "INSERT INTO stories (id, user_id, title, data, schema, template_id, series_id, episode_no, created_at, updated_at) VALUES (?, ?, ?, '{}', 2, ?, ?, ?, ?, ?)",
    ).run(id, userId, title, extra.templateId ?? null, extra.seriesId ?? null, extra.episodeNo ?? null, ts, ts);
    writeStory(id, userId, title, data);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return id;
}

const opSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    entity: z.enum(['character', 'element', 'chapter', 'scene', 'line', 'shot']),
    id: z.string().min(1).max(60),
    parentId: z.string().max(60).nullable().optional(),
    sortKey: z.string().min(1).max(200),
    value: z.record(z.string(), z.unknown()),
  }),
  z.object({ op: z.literal('set'), entity: z.enum(['story', 'character', 'element', 'chapter', 'scene', 'line', 'shot']), id: z.string().min(1).max(60), patch: z.record(z.string(), z.unknown()) }),
  z.object({
    op: z.literal('move'),
    entity: z.enum(['character', 'element', 'chapter', 'scene', 'line', 'shot']),
    id: z.string().min(1).max(60),
    parentId: z.string().max(60).nullable().optional(),
    sortKey: z.string().min(1).max(200),
  }),
  z.object({ op: z.literal('delete'), entity: z.enum(['character', 'element', 'chapter', 'scene', 'line', 'shot']), id: z.string().min(1).max(60) }),
]);

/** 在事务里执行一批 ops，rev+1，记修订，推送给其他设备 */
export function commitOps(storyId: string, userId: string, ops: StoryOp[], clientId: string | null, batchId?: string): { rev: number; ignored: { index: number; reason: string }[] } {
  db.exec('BEGIN IMMEDIATE');
  try {
    // 每天第一次保存前自动留一份历史版本
    const last = db.prepare('SELECT MAX(created_at) AS at FROM story_snapshots WHERE story_id = ?').get(storyId) as Row;
    if (!last.at || now() - Number(last.at) > 24 * 3600 * 1000) snapshotStory(storyId, 'daily');
    const result = applyOps(storyId, userId, ops);
    db.prepare('UPDATE stories SET rev = rev + 1, updated_at = ? WHERE id = ?').run(now(), storyId);
    const rev = Number((db.prepare('SELECT rev FROM stories WHERE id = ?').get(storyId) as Row).rev);
    db.prepare('INSERT OR REPLACE INTO story_revisions (story_id, rev, client_id, ops, created_at) VALUES (?, ?, ?, ?, ?)').run(
      storyId,
      rev,
      batchId ? `${clientId ?? ''}#${batchId}` : clientId,
      JSON.stringify(ops),
      now(),
    );
    if (rev % 100 === 0) db.prepare('DELETE FROM story_revisions WHERE story_id = ? AND rev <= ?').run(storyId, rev - MAX_REVISIONS);
    db.exec('COMMIT');
    publish(userId, { type: 'story-rev', storyId, rev, clientId });
    reindexShotAssets(storyId, ops);
    return { rev, ignored: result.ignored };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 镜头描述、编号、出镜设定、设定名或参考图变了：相关素材的全文索引跟着更新 */
function reindexShotAssets(storyId: string, ops: StoryOp[]): void {
  const shotIds = new Set<string>();
  const elementIds = new Set<string>();
  for (const op of ops) {
    if (op.op === 'set' && op.entity === 'shot' && ['description', 'code', 'characterIds', 'elementIds'].some((f) => f in op.patch)) shotIds.add(op.id);
    if (op.op === 'set' && (op.entity === 'character' || op.entity === 'element') && ['name', 'referenceAssetId', 'refs'].some((f) => f in op.patch)) elementIds.add(op.id);
  }
  const ids = new Set<string>();
  for (const shotId of shotIds) for (const row of db.prepare('SELECT id FROM assets WHERE story_id = ? AND shot_id = ?').all(storyId, shotId) as Row[]) ids.add(String(row.id));
  for (const elementId of elementIds) for (const row of db.prepare("SELECT asset_id FROM entity_assets WHERE entity_type = 'element' AND entity_id = ?").all(elementId) as Row[]) ids.add(String(row.asset_id));
  if (ids.size && ids.size <= 2000) indexAsset(...ids);
}

function toSnapshot(row: Row): StorySnapshot {
  return {
    id: String(row.id),
    rev: Number(row.rev),
    title: String(row.title),
    reason: String(row.reason),
    label: (row.label as string | null) ?? null,
    pinned: Number(row.pinned ?? 0) === 1,
    stats: parseJson(row.stats, null),
    createdAt: Number(row.created_at),
  };
}

export async function storyRoutes(api: FastifyInstance): Promise<void> {
  api.get('/api/stories', async (request) => {
    const query = request.query as { status?: string; seriesId?: string };
    const userId = uid(request);
    const where = ['user_id = ?'];
    const args: (string | number)[] = [userId];
    if (query.status === 'trash') where.push('deleted_at IS NOT NULL');
    else {
      where.push('deleted_at IS NULL');
      if (query.status) {
        where.push('status = ?');
        args.push(query.status);
      }
    }
    if (query.seriesId) {
      where.push('series_id = ?');
      args.push(query.seriesId);
    }
    const rows = db.prepare(`SELECT * FROM stories WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`).all(...args) as Row[];
    const covers = coverIdsFor(userId);
    return rows.map((row) => storySummary(row, covers));
  });

  api.get('/api/story-templates', async () => STORY_TEMPLATES);

  /** 新建故事：可选一个模板（比例、画风、基调、章节场次骨架） */
  api.post('/api/stories', async (request, reply) => {
    const body = parse(z.object({ title: z.string().trim().min(1).max(80), logline: z.string().max(500).default(''), templateId: z.string().max(40).nullable().optional() }), request.body, reply);
    if (!body) return;
    const template = findTemplate(body.templateId);
    if (body.templateId && !template) return bad(reply, '模板不存在');
    const data = defaultData(body.logline);
    if (template) {
      Object.assign(data, template.settings);
      const fresh = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
      data.chapters = template.skeleton.map((chapter) => ({
        id: fresh('ch_'),
        title: chapter.title,
        summary: chapter.summary ?? '',
        scenes: chapter.scenes.map((scene) => ({ id: fresh('sc_'), title: scene.title, location: '', time: '', summary: scene.summary ?? '', dialogue: [], shots: [] })),
      }));
    }
    const id = createStory(uid(request), body.title, data, { templateId: template?.id ?? null });
    return openStory(db.prepare('SELECT * FROM stories WHERE id = ?').get(id) as Row);
  });

  /** 复制故事：结构、设定、台词、镜头全部复制（换新 id），选定的画面沿用原素材 */
  api.post('/api/stories/:id/duplicate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    if (Number(row.schema) !== 2) return bad(reply, '这个故事还没有升级完成', 409);
    const { title, data } = loadStory(id);
    const { data: copy } = remapStoryIds(data);
    for (const chapter of copy.chapters) for (const scene of chapter.scenes) for (const shot of scene.shots) shot.locked = undefined;
    const newId = createStory(uid(request), `${title} 副本`.slice(0, 80), copy, { templateId: (row.template_id as string | null) ?? null });
    return openStory(db.prepare('SELECT * FROM stories WHERE id = ?').get(newId) as Row);
  });

  /** 导出：script.md / script.txt / subtitles.srt / subtitles.ass / shots.csv / keyframes.zip */
  api.get('/api/stories/:id/export/:format', async (request, reply) => {
    const { id, format } = request.params as { id: string; format: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    const { title, data } = Number(row.schema) === 2 ? loadStory(id) : { title: String(row.title), data: parseJson<StoryData>(row.data, defaultData()) };
    const base = title.replace(/[\\/:*?"<>|]/g, '_');
    const send = (name: string, type: string, body: string) => {
      reply.header('content-type', `${type}; charset=utf-8`);
      reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      return reply.send(body);
    };
    switch (format) {
      case 'script.md':
        return send(`${base}-剧本.md`, 'text/markdown', scriptMarkdown(title, data));
      case 'script.txt':
        return send(`${base}-剧本.txt`, 'text/plain', scriptText(title, data));
      case 'subtitles.srt':
        return send(`${base}.srt`, 'application/x-subrip', srt(data));
      case 'subtitles.ass':
        return send(`${base}.ass`, 'text/plain', ass(title, data));
      case 'shots.csv':
        return send(`${base}-镜头表.csv`, 'text/csv', shotsCsv(data));
      case 'keyframes.zip': {
        if (Number(row.schema) !== 2) return bad(reply, '这个故事还没有升级完成', 409);
        const stream = new PassThrough();
        void writeZip(keyframeEntries(id, title, data), stream).then(() => stream.end(), (error) => stream.destroy(error as Error));
        reply.header('content-type', 'application/zip');
        reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${base}-关键帧.zip`)}`);
        return reply.send(stream);
      }
      default:
        return bad(reply, '不支持的导出格式', 404);
    }
  });

  /** 图文排版（绘本 / 四格 / 条漫）：每种版式一份，整份保存 */
  api.get('/api/stories/:id/layouts', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ownedStory(request, id)) return bad(reply, '故事不存在', 404);
    const rows = db.prepare('SELECT * FROM story_layouts WHERE story_id = ? ORDER BY updated_at DESC').all(id) as Row[];
    return rows.map((r) => ({ id: String(r.id), kind: String(r.kind), title: String(r.title), pages: parseJson(r.pages, []), updatedAt: Number(r.updated_at) }));
  });

  api.put('/api/stories/:id/layouts/:kind', async (request, reply) => {
    const { id, kind } = request.params as { id: string; kind: string };
    if (!ownedStory(request, id)) return bad(reply, '故事不存在', 404);
    if (!['picture_book', 'four_panel', 'webtoon'].includes(kind)) return bad(reply, '不支持的版式');
    const body = parse(z.object({ title: z.string().max(80).default(''), pages: z.array(z.record(z.string(), z.unknown())).max(2000) }), request.body, reply);
    if (!body) return;
    const json = JSON.stringify(body.pages);
    if (json.length > 2_000_000) return bad(reply, '版式内容过大');
    db.prepare(
      `INSERT INTO story_layouts (id, story_id, kind, title, pages, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, pages = excluded.pages, updated_at = excluded.updated_at`,
    ).run(`${id}:${kind}`, id, kind, body.title, json, now());
    return { ok: true };
  });

  api.get('/api/stories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    db.prepare('UPDATE stories SET last_opened_at = ? WHERE id = ?').run(now(), id);
    return openStory(row);
  });

  /** 修改故事的元信息：状态（进行中 / 已完成 / 已归档）、上次编辑的位置、封面 */
  api.patch('/api/stories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    const body = parse(
      z.object({
        status: z.enum(['active', 'done', 'archived']).optional(),
        lastPosition: z.object({ tab: z.string().max(20), sceneId: z.string().max(60).nullable().optional() }).optional(),
        coverAssetId: z.string().max(40).nullable().optional(),
      }),
      request.body,
      reply,
    );
    if (!body) return;
    if (body.status) db.prepare('UPDATE stories SET status = ? WHERE id = ?').run(body.status, id);
    if (body.lastPosition) db.prepare('UPDATE stories SET last_position = ? WHERE id = ?').run(JSON.stringify(body.lastPosition), id);
    if (body.coverAssetId !== undefined) db.prepare('UPDATE stories SET cover_asset_id = ? WHERE id = ?').run(body.coverAssetId, id);
    return storySummary(db.prepare('SELECT * FROM stories WHERE id = ?').get(id) as Row);
  });

  /** 增量保存：同一字段后写者胜；指向已删除实体的操作记入 ignored */
  api.post('/api/stories/:id/ops', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    if (Number(row.schema) !== 2) return bad(reply, '这个故事还没有升级完成，暂时只能查看', 409);
    const body = parse(
      z.object({
        baseRev: z.number().int().min(0).optional(),
        clientId: z.string().max(60).nullable().optional(),
        /** 同一批 ops 的编号：断网重放、关页面时的 keepalive 请求可能重复发送，按编号去重 */
        batchId: z.string().max(60).optional(),
        ops: z.array(opSchema).max(5000),
      }),
      request.body,
      reply,
    );
    if (!body) return;
    if (!body.ops.length) return { rev: Number(row.rev), ignored: [] };
    if (body.batchId) {
      const done = db.prepare('SELECT rev FROM story_revisions WHERE story_id = ? AND client_id = ?').get(id, `${body.clientId ?? ''}#${body.batchId}`) as Row | undefined;
      if (done) return { rev: Number(row.rev), ignored: [], duplicate: true };
    }
    return commitOps(id, uid(request), body.ops as StoryOp[], body.clientId ?? null, body.batchId);
  });

  /** 其他设备的修改：since 之后的全部 ops；断开太久（修订记录已清理）时返回 reset，让客户端整篇重新载入 */
  api.get('/api/stories/:id/changes', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    const since = Number((request.query as { since?: string }).since) || 0;
    const rev = Number(row.rev);
    if (since >= rev) return { rev, changes: [] };
    const rows = db.prepare('SELECT rev, client_id, ops FROM story_revisions WHERE story_id = ? AND rev > ? ORDER BY rev').all(id, since) as Row[];
    if (rows.length !== rev - since) return { rev, reset: true, changes: [] };
    return {
      rev,
      changes: rows.map((r) => ({ rev: Number(r.rev), clientId: r.client_id == null ? null : String(r.client_id).split('#')[0], ops: parseJson<StoryOp[]>(r.ops, []) })),
    };
  });

  // 旧版前端的整篇保存：已停用
  api.put('/api/stories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ownedStory(request, id)) return bad(reply, '故事不存在', 404);
    return reply.code(409).send({ error: '织影已升级，请刷新页面', upgraded: true, requestId: request.id });
  });

  /** 故事用到的素材：每个镜头每种用途最新 12 个候选、所有显式选定的素材、角色定妆照、设定参考图 */
  api.get('/api/stories/:id/media', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    const candidates = db
      .prepare(
        `SELECT * FROM (
           SELECT a.*, ROW_NUMBER() OVER (PARTITION BY a.shot_id, a.purpose ORDER BY a.seq DESC) AS rn
           FROM assets a WHERE a.story_id = ? AND a.deleted_at IS NULL
         ) WHERE rn <= 12`,
      )
      .all(id) as Row[];
    const picked = db
      .prepare(
        `SELECT a.* FROM assets a WHERE a.deleted_at IS NULL AND a.id IN (
           SELECT keyframe_asset_id FROM story_shots WHERE story_id = ? AND keyframe_asset_id IS NOT NULL
           UNION SELECT video_asset_id FROM story_shots WHERE story_id = ? AND video_asset_id IS NOT NULL
           UNION SELECT ea.asset_id FROM entity_assets ea JOIN story_elements e ON e.id = ea.entity_id WHERE e.story_id = ?
           UNION SELECT voice_asset_id FROM story_lines WHERE story_id = ? AND voice_asset_id IS NOT NULL
         )`,
      )
      .all(id, id, id, id) as Row[];
    const seen = new Set<string>();
    const rows = [...candidates, ...picked].filter((r) => (seen.has(String(r.id)) ? false : (seen.add(String(r.id)), true)));
    return toAssets(rows);
  });

  /** 批量生成：dryRun=true 只试算（任务数、GPU 时长、预计完成时间），否则存快照后创建任务 */
  api.post('/api/stories/:id/generate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    if (Number(row.schema) !== 2) return bad(reply, '这个故事还没有升级完成', 409);
    const body = parse(
      z.object({
        scope: z.discriminatedUnion('type', [
          z.object({ type: z.literal('all') }),
          z.object({ type: z.literal('chapter'), id: z.string().max(60) }),
          z.object({ type: z.literal('scene'), id: z.string().max(60) }),
          z.object({ type: z.literal('shots'), ids: z.array(z.string().max(60)).min(1).max(5000) }),
        ]),
        content: z.enum(['keyframe', 'video', 'keyframe_then_video']),
        mode: z.enum(['missing', 'append', 'redo']).default('missing'),
        idle: z.boolean().optional(),
        resolution: z.string().max(10).optional(),
        dryRun: z.boolean().default(false),
        /** 先用 AI 给要出视频、还没写过分镜的镜头写视频分镜提示词，写完再开始生成 */
        storyboard: z.boolean().default(false),
      }),
      request.body,
      reply,
    );
    if (!body) return;
    const batch: BatchRequest = { scope: body.scope, content: body.content, mode: body.mode, idle: body.idle, resolution: body.resolution };
    const storyboardShots = body.storyboard ? storyboardTargets(id, batch).length : 0;
    if (body.dryRun) return { plan: planBatch(id, uid(request), batch), created: 0, storyboardShots };
    if (storyboardShots) {
      const jobId = enqueueJob('story-storyboard', { storyId: id, userId: uid(request), request: batch }, { userId: uid(request), dedupeKey: `storyboard:${id}` });
      return { plan: planBatch(id, uid(request), batch), created: 0, storyboardShots, job: toJob(getJobRow(jobId)!) };
    }
    try {
      return await runBatch(id, uid(request), batch);
    } catch (error) {
      return bad(reply, (error as Error).message);
    }
  });

  api.get('/api/stories/:id/snapshots', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ownedStory(request, id)) return bad(reply, '故事不存在', 404);
    const rows = db.prepare('SELECT id, rev, title, reason, label, pinned, stats, created_at FROM story_snapshots WHERE story_id = ? ORDER BY created_at DESC').all(id) as Row[];
    return rows.map(toSnapshot);
  });

  /** 只读预览一个历史版本 */
  api.get('/api/stories/:id/snapshots/:sid', async (request, reply) => {
    const { id, sid } = request.params as { id: string; sid: string };
    if (!ownedStory(request, id)) return bad(reply, '故事不存在', 404);
    const row = db.prepare('SELECT * FROM story_snapshots WHERE id = ? AND story_id = ?').get(sid, id) as Row | undefined;
    if (!row) return bad(reply, '历史版本不存在', 404);
    return { ...toSnapshot(row), data: parseJson<StoryData>(row.data, defaultData()) };
  });

  /** 手动存一个版本（永久保留） */
  api.post('/api/stories/:id/snapshots', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    const body = parse(z.object({ label: z.string().trim().max(60).default('') }), request.body ?? {}, reply);
    if (!body) return;
    const sid = snapshotStory(id, 'manual', { label: body.label || null, pinned: true });
    return toSnapshot(db.prepare('SELECT * FROM story_snapshots WHERE id = ?').get(sid) as Row);
  });

  // 恢复到某个历史版本：先把当前内容存一份，再整篇覆盖
  api.post('/api/stories/:id/snapshots/:sid/restore', async (request, reply) => {
    const { id, sid } = request.params as { id: string; sid: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    if (Number(row.schema) !== 2) return bad(reply, '这个故事还没有升级完成，暂时不能恢复', 409);
    const snapshot = db.prepare('SELECT * FROM story_snapshots WHERE id = ? AND story_id = ?').get(sid, id) as Row | undefined;
    if (!snapshot) return bad(reply, '历史版本不存在', 404);
    const { normalizeLegacy } = await import('../stories/migrate.ts');
    const raw = parseJson<StoryData>(snapshot.data, defaultData());
    // 新版快照原样恢复；旧版（迁移前）快照先补齐字段
    const data = Array.isArray(raw.elements) ? { ...normalizeLegacy(raw), ...raw } : normalizeLegacy(raw);
    db.exec('BEGIN IMMEDIATE');
    try {
      snapshotStory(id, 'before_restore');
      writeStory(id, uid(request), String(snapshot.title), data);
      db.prepare('UPDATE stories SET rev = rev + 1, updated_at = ? WHERE id = ?').run(now(), id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const fresh = db.prepare('SELECT * FROM stories WHERE id = ?').get(id) as Row;
    publish(uid(request), { type: 'story-rev', storyId: id, rev: Number(fresh.rev), clientId: null });
    return openStory(fresh);
  });

  /** 删除：先进回收站；回收站里的再删一次彻底删除 */
  api.delete('/api/stories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.prepare('SELECT * FROM stories WHERE id = ? AND user_id = ?').get(id, uid(request)) as Row | undefined;
    if (!row) return bad(reply, '故事不存在', 404);
    if (row.deleted_at == null && (request.query as { purge?: string }).purge !== '1') {
      db.prepare('UPDATE stories SET deleted_at = ? WHERE id = ?').run(now(), id);
      return { ok: true, trashed: true };
    }
    db.prepare('DELETE FROM stories WHERE id = ?').run(id);
    db.prepare("DELETE FROM tasks WHERE story_id = ? AND status != 'running'").run(id);
    db.prepare('UPDATE assets SET story_id = NULL, shot_id = NULL, purpose = NULL WHERE story_id = ?').run(id);
    return { ok: true, purged: true };
  });

  // ---------------- 接续上一镜尾帧：等待列表 / 单镜排队 / 取消 ----------------
  api.get('/api/stories/:id/chains', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ownedStory(request, id)) return bad(reply, '故事不存在', 404);
    return listChains(id);
  });

  /** 单个镜头：上一镜视频还在生成时，排在它后面（完成后自动截尾帧生成这一镜） */
  api.post('/api/stories/:id/chains', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    if (Number(row.schema) !== 2) return bad(reply, '这个故事还没有升级完成', 409);
    const body = parse(z.object({ shotId: z.string().max(60), resolution: z.string().max(20).optional() }), request.body, reply);
    if (!body) return;
    const { data } = loadStory(id);
    let prev: string | null = null;
    let found = false;
    for (const chapter of data.chapters)
      for (const scene of chapter.scenes)
        for (const shot of scene.shots) {
          if (found) continue;
          if (shot.id === body.shotId) found = true;
          else prev = shot.id;
        }
    if (!found) return bad(reply, '镜头不存在', 404);
    if (!prev) return bad(reply, '这是第一个镜头，没有上一镜可以接续');
    addChain(id, uid(request), body.shotId, prev, { resolution: body.resolution ?? null });
    return { ok: true, afterShotId: prev };
  });

  api.delete('/api/stories/:id/chains/:shotId', async (request, reply) => {
    const { id, shotId } = request.params as { id: string; shotId: string };
    if (!ownedStory(request, id)) return bad(reply, '故事不存在', 404);
    return { ok: cancelChain(id, shotId) };
  });

  // ---------------- 成片（EXP-03） ----------------
  const filmOptions = z.object({
    stills: z.boolean().default(true),
    voice: z.boolean().default(true),
    musicAssetId: z.string().max(40).nullable().optional(),
    musicVolume: z.number().min(0).max(1).optional(),
  });

  api.post('/api/stories/:id/film/plan', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    if (Number(row.schema) !== 2) return bad(reply, '这个故事还没有升级完成', 409);
    const body = parse(filmOptions, request.body ?? {}, reply);
    if (!body) return;
    return planFilm(id, body);
  });

  api.post('/api/stories/:id/film', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    if (Number(row.schema) !== 2) return bad(reply, '这个故事还没有升级完成', 409);
    const body = parse(filmOptions, request.body ?? {}, reply);
    if (!body) return;
    if (body.musicAssetId && !db.prepare("SELECT 1 FROM assets WHERE id = ? AND user_id = ? AND kind = 'audio' AND deleted_at IS NULL").get(body.musicAssetId, uid(request)))
      return bad(reply, '配乐素材不存在');
    const plan = await planFilm(id, body);
    if (!plan.ffmpeg) return bad(reply, '服务器没有安装 ffmpeg，不能渲染成片（Docker 部署时设置 WITH_FFMPEG=1 重新构建镜像）');
    if (!plan.clips) return bad(reply, '还没有可用的镜头视频');
    const jobId = enqueueJob('story-film', { storyId: id, userId: uid(request), options: body }, { userId: uid(request), dedupeKey: `film:${id}` });
    return { job: toJob(getJobRow(jobId)!), plan };
  });

  api.get('/api/stories/:id/films', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ownedStory(request, id)) return bad(reply, '故事不存在', 404);
    return toAssets(filmVersions(id));
  });

  // ---------------- 配音（EXP-08） ----------------
  api.get('/api/tts', async () => ({ mode: ttsMode() }));

  api.post('/api/stories/:id/voice', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    if (Number(row.schema) !== 2) return bad(reply, '这个故事还没有升级完成', 409);
    const body = parse(z.object({ lineIds: z.array(z.string().max(60)).max(2000).optional(), overwrite: z.boolean().default(false) }), request.body ?? {}, reply);
    if (!body) return;
    const count = voiceTargets(id, body).length;
    if (!count) return bad(reply, body.overwrite ? '没有可配音的台词' : '台词都已经有配音了');
    const jobId = enqueueJob('story-voice', { storyId: id, userId: uid(request), ...body }, { userId: uid(request), dedupeKey: `voice:${id}` });
    return { job: toJob(getJobRow(jobId)!), count, mode: ttsMode() };
  });

  // ---------------- 审片备注（STY-15） ----------------
  const toNote = (r: Row) => ({
    id: String(r.id),
    shotId: (r.shot_id as string | null) ?? null,
    atSec: r.at_sec == null ? null : Number(r.at_sec),
    text: String(r.text),
    resolved: Number(r.resolved) === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });

  api.get('/api/stories/:id/notes', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ownedStory(request, id)) return bad(reply, '故事不存在', 404);
    return (db.prepare('SELECT * FROM story_notes WHERE story_id = ? ORDER BY resolved, created_at').all(id) as Row[]).map(toNote);
  });

  api.post('/api/stories/:id/notes', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ownedStory(request, id)) return bad(reply, '故事不存在', 404);
    const body = parse(z.object({ shotId: z.string().max(60).nullable().optional(), atSec: z.number().min(0).max(100_000).nullable().optional(), text: z.string().trim().min(1).max(2000) }), request.body, reply);
    if (!body) return;
    if (body.shotId && !db.prepare('SELECT 1 FROM story_shots WHERE id = ? AND story_id = ?').get(body.shotId, id)) return bad(reply, '镜头不存在');
    const noteId = newId('n_');
    db.prepare('INSERT INTO story_notes (id, story_id, shot_id, user_id, at_sec, text, resolved, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)').run(
      noteId, id, body.shotId ?? null, uid(request), body.atSec ?? null, body.text, now(), now(),
    );
    return toNote(db.prepare('SELECT * FROM story_notes WHERE id = ?').get(noteId) as Row);
  });

  api.patch('/api/stories/:id/notes/:noteId', async (request, reply) => {
    const { id, noteId } = request.params as { id: string; noteId: string };
    if (!ownedStory(request, id)) return bad(reply, '故事不存在', 404);
    const body = parse(z.object({ text: z.string().trim().min(1).max(2000).optional(), resolved: z.boolean().optional() }), request.body, reply);
    if (!body) return;
    const row = db.prepare('SELECT * FROM story_notes WHERE id = ? AND story_id = ?').get(noteId, id) as Row | undefined;
    if (!row) return bad(reply, '备注不存在', 404);
    db.prepare('UPDATE story_notes SET text = ?, resolved = ?, updated_at = ? WHERE id = ?').run(body.text ?? String(row.text), (body.resolved ?? Number(row.resolved) === 1) ? 1 : 0, now(), noteId);
    return toNote(db.prepare('SELECT * FROM story_notes WHERE id = ?').get(noteId) as Row);
  });

  api.delete('/api/stories/:id/notes/:noteId', async (request, reply) => {
    const { id, noteId } = request.params as { id: string; noteId: string };
    if (!ownedStory(request, id)) return bad(reply, '故事不存在', 404);
    db.prepare('DELETE FROM story_notes WHERE id = ? AND story_id = ?').run(noteId, id);
    return { ok: true };
  });

  // ---------------- 故事包（EXP-04） ----------------
  api.get('/api/stories/:id/package', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    if (Number(row.schema) !== 2) return bad(reply, '这个故事还没有升级完成', 409);
    const { title, entries } = packageEntries(id, uid(request));
    const stream = new PassThrough();
    void writeZip(entries(), stream).then(() => stream.end(), (error) => stream.destroy(error as Error));
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${title.replace(/[\\/:*?"<>|]/g, '_')}.weave.zip`)}`);
    return reply.send(stream);
  });

  // 故事包的请求体是原始字节流，直接写盘
  for (const type of ['application/zip', 'application/octet-stream']) api.addContentTypeParser(type, (_request, payload, done) => done(null, payload));

  api.post('/api/stories/import', async (request, reply) => {
    const body = request.body as Readable | undefined;
    if (!body || typeof (body as Readable).pipe !== 'function') return bad(reply, '请上传 .weave.zip 文件（content-type: application/zip）');
    const temp = await newTempFile('zip');
    try {
      let size = 0;
      body.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 ** 3) body.destroy(new Error('故事包超过 4 GB'));
      });
      await pipeline(body, createWriteStream(temp));
      const imported = await importPackage(temp, uid(request)).catch((error: Error) => error);
      if (imported instanceof Error) return bad(reply, imported.message);
      const storyId = createStory(uid(request), imported.title, imported.data);
      attachImportedAssets(storyId, imported);
      const story = openStory(db.prepare('SELECT * FROM stories WHERE id = ?').get(storyId) as Row);
      return { ...story, imported: { assets: imported.assets.length, skipped: imported.skipped } };
    } finally {
      await fs.rm(temp, { force: true });
    }
  });

  api.post('/api/stories/:id/restore', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = db.prepare('UPDATE stories SET deleted_at = NULL WHERE id = ? AND user_id = ?').run(id, uid(request));
    if (!result.changes) return bad(reply, '故事不存在', 404);
    return { ok: true };
  });
}

export { pruneSnapshots };
