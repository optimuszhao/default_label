// 故事：增删改查、冲突检测、历史版本
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { StoryData, StorySummary } from '../../shared/types.ts';
import { db, newId, now, parseJson, type Row } from '../db.ts';
import { assetUrl } from '../repo.ts';
import { bad, parse, uid } from './common.ts';

/** 每个故事最多保留的历史版本数 */
const MAX_SNAPSHOTS = 50;

export function snapshotStory(row: Row, reason: string): void {
  db.prepare('INSERT INTO story_snapshots (id, story_id, rev, title, data, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    newId('ss_'),
    String(row.id),
    Number(row.rev ?? 0),
    String(row.title),
    String(row.data),
    reason,
    now(),
  );
  db.prepare(
    `DELETE FROM story_snapshots WHERE story_id = ? AND id NOT IN
       (SELECT id FROM story_snapshots WHERE story_id = ? ORDER BY created_at DESC LIMIT ${MAX_SNAPSHOTS})`,
  ).run(String(row.id), String(row.id));
}

export function ownedStory(request: FastifyRequest, id: string): Row | undefined {
  return db.prepare('SELECT * FROM stories WHERE id = ? AND user_id = ?').get(id, uid(request)) as Row | undefined;
}

function emptyStory(logline = ''): StoryData {
  return {
    logline,
    genre: '',
    tone: '',
    visualStyle: '电影质感，写实光影，35mm 胶片颗粒',
    aspectRatio: '16:9',
    outline: '',
    characters: [],
    chapters: [],
  };
}

/** coverIds：故事 id → 封面资产 id，列表页一次查出，避免每个故事查一次 */
function storySummary(row: Row, coverIds?: Map<string, string>): StorySummary {
  const data = parseJson<StoryData>(row.data, emptyStory());
  const shotCount = data.chapters.reduce(
    (sum, chapter) => sum + chapter.scenes.reduce((s, scene) => s + scene.shots.length, 0),
    0,
  );
  const coverId = coverIds
    ? coverIds.get(String(row.id))
    : (db
        .prepare("SELECT id FROM assets WHERE story_id = ? AND kind = 'image' ORDER BY created_at DESC LIMIT 1")
        .get(String(row.id)) as Row | undefined)?.id;
  return {
    id: String(row.id),
    title: String(row.title),
    rev: Number(row.rev ?? 0),
    logline: data.logline,
    coverUrl: coverId ? assetUrl(String(coverId)) : null,
    shotCount,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** 每个故事最新一张图片作为封面 */
function coverIdsFor(userId: string): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT story_id, id FROM (
         SELECT story_id, id, ROW_NUMBER() OVER (PARTITION BY story_id ORDER BY created_at DESC) AS n
         FROM assets WHERE user_id = ? AND story_id IS NOT NULL AND kind = 'image'
       ) WHERE n = 1`,
    )
    .all(userId) as Row[];
  return new Map(rows.map((row) => [String(row.story_id), String(row.id)]));
}

export async function storyRoutes(api: FastifyInstance): Promise<void> {
  api.get('/api/stories', async (request) => {
    const rows = db.prepare('SELECT * FROM stories WHERE user_id = ? ORDER BY updated_at DESC').all(uid(request)) as Row[];
    const covers = coverIdsFor(uid(request));
    return rows.map((row) => storySummary(row, covers));
  });

  api.post('/api/stories', async (request, reply) => {
    const body = parse(
      z.object({ title: z.string().trim().min(1).max(80), logline: z.string().max(500).default('') }),
      request.body,
      reply,
    );
    if (!body) return;
    const id = newId('s_');
    const ts = now();
    db.prepare('INSERT INTO stories (id, user_id, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      uid(request),
      body.title,
      JSON.stringify(emptyStory(body.logline)),
      ts,
      ts,
    );
    const row = db.prepare('SELECT * FROM stories WHERE id = ?').get(id) as Row;
    return { ...storySummary(row), data: parseJson<StoryData>(row.data, emptyStory()) };
  });

  api.get('/api/stories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.prepare('SELECT * FROM stories WHERE id = ? AND user_id = ?').get(id, uid(request)) as Row | undefined;
    if (!row) return bad(reply, '故事不存在', 404);
    return { ...storySummary(row), data: parseJson<StoryData>(row.data, emptyStory()) };
  });

  api.put('/api/stories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(80),
        data: z.record(z.string(), z.unknown()),
        /** 客户端编辑所基于的版本；和服务器不一致说明别处改过，返回 409 */
        baseRev: z.number().int().min(0).optional(),
      }),
      request.body,
      reply,
    );
    if (!body) return;
    const json = JSON.stringify(body.data);
    if (json.length > 5_000_000) return bad(reply, '故事内容过大');
    const row = db.prepare('SELECT * FROM stories WHERE id = ? AND user_id = ?').get(id, uid(request)) as Row | undefined;
    if (!row) return bad(reply, '故事不存在', 404);
    const rev = Number(row.rev);
    if (body.baseRev !== undefined && body.baseRev !== rev) {
      return reply.code(409).send({ error: '这个故事已在其他设备或标签页更新', rev, updatedAt: Number(row.updated_at) });
    }
    const ts = now();
    // 每天自动留一份旧版本
    const lastSnapshot = db.prepare('SELECT MAX(created_at) AS at FROM story_snapshots WHERE story_id = ?').get(id) as Row;
    if (!lastSnapshot.at || ts - Number(lastSnapshot.at) > 24 * 3600 * 1000) snapshotStory(row, 'daily');
    const result = db
      .prepare('UPDATE stories SET title = ?, data = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?')
      .run(body.title, json, ts, id, rev);
    if (!result.changes) {
      return reply.code(409).send({ error: '这个故事已在其他设备或标签页更新', rev: rev + 1, updatedAt: ts });
    }
    return { ok: true, rev: rev + 1, updatedAt: ts };
  });

  api.get('/api/stories/:id/snapshots', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ownedStory(request, id)) return bad(reply, '故事不存在', 404);
    const rows = db
      .prepare('SELECT id, rev, title, reason, created_at FROM story_snapshots WHERE story_id = ? ORDER BY created_at DESC')
      .all(id) as Row[];
    return rows.map((r) => ({ id: String(r.id), rev: Number(r.rev), title: String(r.title), reason: String(r.reason), createdAt: Number(r.created_at) }));
  });

  // 恢复到某个历史版本：先把当前内容存一份，再覆盖
  api.post('/api/stories/:id/snapshots/:sid/restore', async (request, reply) => {
    const { id, sid } = request.params as { id: string; sid: string };
    const row = ownedStory(request, id);
    if (!row) return bad(reply, '故事不存在', 404);
    const snapshot = db.prepare('SELECT * FROM story_snapshots WHERE id = ? AND story_id = ?').get(sid, id) as Row | undefined;
    if (!snapshot) return bad(reply, '历史版本不存在', 404);
    snapshotStory(row, 'restore');
    db.prepare('UPDATE stories SET title = ?, data = ?, rev = rev + 1, updated_at = ? WHERE id = ?').run(
      String(snapshot.title),
      String(snapshot.data),
      now(),
      id,
    );
    const fresh = db.prepare('SELECT * FROM stories WHERE id = ?').get(id) as Row;
    return { ...storySummary(fresh), data: parseJson<StoryData>(fresh.data, emptyStory()) };
  });

  api.delete('/api/stories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = db.prepare('DELETE FROM stories WHERE id = ? AND user_id = ?').run(id, uid(request));
    if (!result.changes) return bad(reply, '故事不存在', 404);
    db.prepare("DELETE FROM tasks WHERE story_id = ? AND status != 'running'").run(id);
    db.prepare('UPDATE assets SET story_id = NULL, shot_id = NULL, purpose = NULL WHERE story_id = ?').run(id);
    return { ok: true };
  });
}
