// 系列（多集）：同一系列的各集共享画风、比例、默认种子，以及标记为"系列共享"的设定；
// 系列看板汇总每一集的进度；新建一集时可以复制上一集的章节场次结构。
// 另外：从创作台把一张图 / 一段视频"加入故事镜头"；取前几集的前情提要给 AI 当上下文。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StoryData } from '../../shared/types.ts';
import { keyBetween, type StoryOp } from '../../shared/story-ops.ts';
import { db, newId, now, parseJson, type Row } from '../db.ts';
import { indexAsset } from '../files.ts';
import { getAssetRow } from '../repo.ts';
import { defaultData, loadStory } from '../stories/store.ts';
import { bad, parse, uid } from './common.ts';
import { commitOps, createStory, openStory, ownedStory } from './stories.ts';

const SERIES_SETTINGS = z.object({
  visualStyle: z.string().max(500).optional(),
  aspectRatio: z.string().max(10).optional(),
  defaultSeed: z.number().int().nullable().optional(),
  negativePrompt: z.string().max(2000).optional(),
  genre: z.string().max(40).optional(),
  tone: z.string().max(100).optional(),
});

function ownedSeries(userId: string, id: string): Row | undefined {
  return db.prepare('SELECT * FROM story_series WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, userId) as Row | undefined;
}

function episodes(seriesId: string): Row[] {
  return db.prepare('SELECT * FROM stories WHERE series_id = ? AND deleted_at IS NULL ORDER BY episode_no, created_at').all(seriesId) as Row[];
}

function seriesSummary(row: Row) {
  const list = episodes(String(row.id));
  const totals = { episodes: list.length, shots: 0, duration: 0 };
  for (const episode of list) {
    const stats = parseJson<{ shots?: number; duration?: number }>(episode.stats, {});
    totals.shots += stats.shots ?? 0;
    totals.duration += stats.duration ?? 0;
  }
  return {
    id: String(row.id),
    title: String(row.title),
    settings: parseJson<Record<string, unknown>>(row.settings, {}),
    coverAssetId: (row.cover_asset_id as string | null) ?? null,
    totals,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** 一集里每个镜头选好关键帧 / 视频的数量（系列看板用） */
function episodeProgress(storyId: string) {
  const shots = db.prepare('SELECT id, keyframe_asset_id, video_asset_id, locked FROM story_shots WHERE story_id = ?').all(storyId) as Row[];
  const have = new Map<string, { keyframe: boolean; video: boolean }>();
  for (const row of db
    .prepare("SELECT shot_id, purpose FROM assets WHERE story_id = ? AND shot_id IS NOT NULL AND deleted_at IS NULL AND COALESCE(flag, '') <> 'reject' GROUP BY shot_id, purpose")
    .all(storyId) as Row[]) {
    const entry = have.get(String(row.shot_id)) ?? { keyframe: false, video: false };
    if (row.purpose === 'video') entry.video = true;
    else entry.keyframe = true;
    have.set(String(row.shot_id), entry);
  }
  let keyframes = 0;
  let videos = 0;
  let locked = 0;
  for (const shot of shots) {
    const entry = have.get(String(shot.id));
    if (shot.keyframe_asset_id || entry?.keyframe) keyframes++;
    if (shot.video_asset_id || entry?.video) videos++;
    if (Number(shot.locked) === 1) locked++;
  }
  return { shots: shots.length, keyframes, videos, locked };
}

export async function seriesRoutes(api: FastifyInstance): Promise<void> {
  api.get('/api/series', async (request) => {
    const rows = db.prepare('SELECT * FROM story_series WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC').all(uid(request)) as Row[];
    return rows.map(seriesSummary);
  });

  api.post('/api/series', async (request, reply) => {
    const body = parse(z.object({ title: z.string().trim().min(1).max(80), settings: SERIES_SETTINGS.default({}) }), request.body, reply);
    if (!body) return;
    const id = newId('sr_');
    db.prepare('INSERT INTO story_series (id, user_id, title, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, uid(request), body.title, JSON.stringify(body.settings), now(), now());
    return seriesSummary(db.prepare('SELECT * FROM story_series WHERE id = ?').get(id) as Row);
  });

  /** 系列看板：每一集的进度、共享设定 */
  api.get('/api/series/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ownedSeries(uid(request), id);
    if (!row) return bad(reply, '系列不存在', 404);
    const shared = db.prepare('SELECT id, kind, name, story_id FROM story_elements WHERE series_id = ? AND deleted_at IS NULL ORDER BY kind, sort_key').all(id) as Row[];
    return {
      ...seriesSummary(row),
      episodes: episodes(id).map((episode) => ({
        id: String(episode.id),
        title: String(episode.title),
        episodeNo: episode.episode_no == null ? null : Number(episode.episode_no),
        status: String(episode.status),
        stats: parseJson(episode.stats, {}),
        progress: Number(episode.schema) === 2 ? episodeProgress(String(episode.id)) : null,
        updatedAt: Number(episode.updated_at),
      })),
      shared: shared.map((item) => ({ id: String(item.id), kind: String(item.kind), name: String(item.name), storyId: (item.story_id as string | null) ?? null })),
    };
  });

  api.patch('/api/series/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = ownedSeries(uid(request), id);
    if (!row) return bad(reply, '系列不存在', 404);
    const body = parse(z.object({ title: z.string().trim().min(1).max(80).optional(), settings: SERIES_SETTINGS.optional() }), request.body, reply);
    if (!body) return;
    if (body.title) db.prepare('UPDATE story_series SET title = ? WHERE id = ?').run(body.title, id);
    if (body.settings) db.prepare('UPDATE story_series SET settings = ? WHERE id = ?').run(JSON.stringify({ ...parseJson(row.settings, {}), ...body.settings }), id);
    db.prepare('UPDATE story_series SET updated_at = ? WHERE id = ?').run(now(), id);
    return seriesSummary(db.prepare('SELECT * FROM story_series WHERE id = ?').get(id) as Row);
  });

  /** 删除系列：各集保留，变成独立故事；共享设定变回各自故事私有 */
  api.delete('/api/series/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ownedSeries(uid(request), id)) return bad(reply, '系列不存在', 404);
    db.prepare('UPDATE stories SET series_id = NULL, episode_no = NULL WHERE series_id = ?').run(id);
    db.prepare('UPDATE story_elements SET series_id = NULL WHERE series_id = ?').run(id);
    db.prepare('DELETE FROM story_series WHERE id = ?').run(id);
    return { ok: true };
  });

  /** 新建一集：继承系列设定；可以复制某一集（默认上一集）的章节和场次结构（不含镜头） */
  api.post('/api/series/:id/episodes', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = uid(request);
    const series = ownedSeries(userId, id);
    if (!series) return bad(reply, '系列不存在', 404);
    const body = parse(z.object({ title: z.string().trim().min(1).max(80), copyStructureFrom: z.string().max(40).nullable().optional() }), request.body, reply);
    if (!body) return;
    const list = episodes(id);
    const episodeNo = list.reduce((max, episode) => Math.max(max, Number(episode.episode_no ?? 0)), 0) + 1;
    const settings = parseJson<Partial<StoryData>>(series.settings, {});
    const data: StoryData = { ...defaultData(), ...settings, characters: [], elements: [], chapters: [] };
    const source = body.copyStructureFrom === undefined ? list.at(-1) : list.find((episode) => episode.id === body.copyStructureFrom);
    if (body.copyStructureFrom !== null && source && Number(source.schema) === 2) {
      const prev = loadStory(String(source.id)).data;
      const fresh = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
      data.chapters = prev.chapters.map((chapter) => ({
        id: fresh('ch_'),
        title: chapter.title,
        summary: '',
        scenes: chapter.scenes.map((scene) => ({ id: fresh('sc_'), title: scene.title, location: scene.location, locationId: scene.locationId ?? null, time: scene.time, summary: '', dialogue: [], shots: [] })),
      }));
    }
    const storyId = createStory(userId, body.title, data, { seriesId: id, episodeNo });
    db.prepare('UPDATE story_series SET updated_at = ? WHERE id = ?').run(now(), id);
    return openStory(db.prepare('SELECT * FROM stories WHERE id = ?').get(storyId) as Row);
  });

  /** 把已有故事加入系列（或移出：seriesId 为 null） */
  api.post('/api/stories/:id/series', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = uid(request);
    const story = ownedStory(request, id);
    if (!story) return bad(reply, '故事不存在', 404);
    const body = parse(z.object({ seriesId: z.string().max(40).nullable(), episodeNo: z.number().int().min(1).max(9999).optional() }), request.body, reply);
    if (!body) return;
    if (body.seriesId && !ownedSeries(userId, body.seriesId)) return bad(reply, '系列不存在', 404);
    const episodeNo = body.seriesId ? (body.episodeNo ?? episodes(body.seriesId).reduce((max, e) => Math.max(max, Number(e.episode_no ?? 0)), 0) + 1) : null;
    db.prepare('UPDATE stories SET series_id = ?, episode_no = ? WHERE id = ?').run(body.seriesId, episodeNo, id);
    // 移出系列：这一集共享出去的设定不再共享
    if (!body.seriesId) db.prepare('UPDATE story_elements SET series_id = NULL WHERE story_id = ?').run(id);
    else db.prepare("UPDATE story_elements SET series_id = ? WHERE story_id = ? AND json_extract(data, '$.seriesShared') = 1").run(body.seriesId, id);
    return { ok: true, episodeNo };
  });

  /** AI 上下文：同一系列前几集各章的前情提要 */
  api.get('/api/stories/:id/context', async (request, reply) => {
    const { id } = request.params as { id: string };
    const story = ownedStory(request, id);
    if (!story) return bad(reply, '故事不存在', 404);
    if (!story.series_id) return { previous: [] };
    const prev = db
      .prepare('SELECT id, title, episode_no FROM stories WHERE series_id = ? AND deleted_at IS NULL AND schema = 2 AND COALESCE(episode_no, 0) < ? ORDER BY episode_no')
      .all(String(story.series_id), Number(story.episode_no ?? 0)) as Row[];
    return {
      previous: prev.map((episode) => ({
        episodeNo: Number(episode.episode_no),
        title: String(episode.title),
        recaps: (db.prepare("SELECT title, recap FROM story_chapters WHERE story_id = ? AND recap <> '' ORDER BY sort_key").all(String(episode.id)) as Row[]).map((row) => `${row.title}：${row.recap}`),
      })),
    };
  });

  /** 从创作台把素材加入故事：在指定场次末尾新建一个镜头，素材作为这个镜头的选定关键帧（或视频） */
  api.post('/api/stories/:id/shots/from-asset', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = uid(request);
    const story = ownedStory(request, id);
    if (!story) return bad(reply, '故事不存在', 404);
    if (Number(story.schema) !== 2) return bad(reply, '这个故事还没有升级完成', 409);
    const body = parse(z.object({ assetId: z.string().max(40), sceneId: z.string().max(60) }), request.body, reply);
    if (!body) return;
    const asset = getAssetRow(body.assetId);
    if (!asset || asset.user_id !== userId || asset.deleted_at != null) return bad(reply, '素材不存在', 404);
    if (asset.kind === 'audio') return bad(reply, '音频不能作为镜头画面');
    const scene = db.prepare('SELECT id FROM story_scenes WHERE id = ? AND story_id = ?').get(body.sceneId, id) as Row | undefined;
    if (!scene) return bad(reply, '场次不存在', 404);
    const last = db.prepare('SELECT sort_key FROM story_shots WHERE scene_id = ? ORDER BY sort_key DESC LIMIT 1').get(body.sceneId) as Row | undefined;
    const shotId = `sh_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
    const video = asset.kind === 'video';
    const ops: StoryOp[] = [
      {
        op: 'create',
        entity: 'shot',
        id: shotId,
        parentId: body.sceneId,
        sortKey: keyBetween((last?.sort_key as string | undefined) ?? null, null),
        value: {
          shotSize: '中景',
          cameraMove: '固定',
          description: String(asset.prompt ?? '').slice(0, 500),
          duration: video ? Math.max(1, Math.round(Number(asset.duration ?? 5))) : 5,
          dialogueIds: [],
          characterIds: [],
          keyframeAssetId: video ? null : body.assetId,
          videoAssetId: video ? body.assetId : null,
        },
      },
    ];
    const result = commitOps(id, userId, ops, null);
    // 素材还没归属任何故事时，挂到这个镜头下，作为它的候选
    if (!asset.story_id) {
      db.prepare('UPDATE assets SET story_id = ?, shot_id = ?, purpose = ? WHERE id = ?').run(id, shotId, video ? 'video' : 'keyframe', body.assetId);
      indexAsset(body.assetId);
    }
    return { shotId, rev: result.rev };
  });
}
