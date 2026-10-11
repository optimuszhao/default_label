// 资产库的组织结构：文件夹（虚拟目录，最多 4 层）、标签、智能文件夹（保存的查询），
// 以及存储统计和重复文件合并
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AssetFolder, AssetTag, SavedSearch, StorageUsage } from '../../shared/types.ts';
import { publish } from '../bus.ts';
import { config } from '../config.ts';
import { db, newId, now, parseJson, type Row } from '../db.ts';
import { indexAsset, purgeAsset } from '../files.ts';
import { cancelJob, getJobRow, toJob } from '../jobs/runner.ts';
import { assetQuerySchema } from '../library/query.ts';
import { normalizeTag } from '../library/tags.ts';
import { replaceAssetRefs } from '../library/usage.ts';
import { getAssetRow, loadAsset, toAssets } from '../repo.ts';
import { bad, parse, uid } from './common.ts';

const MAX_DEPTH = 4;

function folderDepth(userId: string, folderId: string | null): number {
  let depth = 0;
  let current = folderId;
  while (current && depth < 20) {
    const row = db.prepare('SELECT parent_id FROM folders WHERE id = ? AND user_id = ?').get(current, userId) as Row | undefined;
    if (!row) break;
    depth++;
    current = (row.parent_id as string | null) ?? null;
  }
  return depth;
}

/** 子树的高度（自己算 1 层） */
function subtreeHeight(userId: string, folderId: string): number {
  const children = db.prepare('SELECT id FROM folders WHERE parent_id = ? AND user_id = ?').all(folderId, userId) as Row[];
  return 1 + Math.max(0, ...children.map((child) => subtreeHeight(userId, String(child.id))));
}

function isDescendant(userId: string, folderId: string, maybeChild: string | null): boolean {
  let current = maybeChild;
  let guard = 0;
  while (current && guard++ < 50) {
    if (current === folderId) return true;
    const row = db.prepare('SELECT parent_id FROM folders WHERE id = ? AND user_id = ?').get(current, userId) as Row | undefined;
    current = (row?.parent_id as string | null) ?? null;
  }
  return false;
}

function listFolders(userId: string): AssetFolder[] {
  const rows = db
    .prepare(
      `SELECT f.id, f.parent_id, f.name,
         (SELECT COUNT(*) FROM assets a WHERE a.folder_id = f.id AND a.deleted_at IS NULL) AS n
       FROM folders f WHERE f.user_id = ? ORDER BY f.sort, f.name`,
    )
    .all(userId) as Row[];
  return rows.map((row) => ({ id: String(row.id), parentId: (row.parent_id as string | null) ?? null, name: String(row.name), count: Number(row.n) }));
}

function listTags(userId: string): AssetTag[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.name, (SELECT COUNT(*) FROM asset_tags at JOIN assets a ON a.id = at.asset_id WHERE at.tag_id = t.id AND a.deleted_at IS NULL) AS n
       FROM tags t WHERE t.user_id = ? ORDER BY t.name`,
    )
    .all(userId) as Row[];
  return rows.map((row) => ({ id: String(row.id), name: String(row.name), count: Number(row.n) }));
}

function diskInfo(): StorageUsage['disk'] {
  try {
    const stat = fs.statfsSync(config.mediaDir);
    return { free: stat.bavail * stat.bsize, total: stat.blocks * stat.bsize };
  } catch {
    return null;
  }
}

/** 一组重复文件里保留哪一个：有评分、收藏、被引用的优先，其次最早的 */
function pickKeeper(rows: Row[]): Row {
  return [...rows].sort((a, b) => {
    const score = (row: Row) => Number(row.favorite) * 10 + Number(row.rating) + (row.story_id ? 5 : 0);
    return score(b) - score(a) || Number(a.seq) - Number(b.seq);
  })[0];
}

async function mergeGroup(userId: string, rows: Row[]): Promise<number> {
  if (rows.length < 2) return 0;
  const keep = pickKeeper(rows);
  const others = rows.filter((row) => row.id !== keep.id);
  const otherIds = others.map((row) => String(row.id));
  replaceAssetRefs(userId, otherIds, String(keep.id));
  // 合并组织信息：收藏取或、评分取最高、标签取并集、备注拼接
  const favorite = rows.some((row) => Number(row.favorite) === 1) ? 1 : 0;
  const rating = Math.max(...rows.map((row) => Number(row.rating)));
  const notes = [...new Set(rows.map((row) => String(row.note ?? '')).filter(Boolean))].join('\n');
  db.prepare('UPDATE assets SET favorite = ?, rating = ?, note = ?, folder_id = COALESCE(folder_id, ?) WHERE id = ?').run(
    favorite,
    rating,
    notes,
    (others.find((row) => row.folder_id)?.folder_id as string | null) ?? null,
    String(keep.id),
  );
  for (const id of otherIds) db.prepare('INSERT OR IGNORE INTO asset_tags (asset_id, tag_id) SELECT ?, tag_id FROM asset_tags WHERE asset_id = ?').run(String(keep.id), id);
  for (const row of others) await purgeAsset(row);
  indexAsset(String(keep.id));
  publish(userId, { type: 'assets-removed', ids: otherIds });
  return others.length;
}

export async function libraryRoutes(api: FastifyInstance): Promise<void> {
  // ---- 后台作业（成片渲染、批量处理……）的进度查询和取消 ----
  api.get('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getJobRow(id);
    if (!row || row.user_id !== uid(request)) return bad(reply, '作业不存在', 404);
    return toJob(row);
  });

  api.post('/api/jobs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getJobRow(id);
    if (!row || row.user_id !== uid(request)) return bad(reply, '作业不存在', 404);
    cancelJob(id);
    return toJob(getJobRow(id)!);
  });

  // ---- 文件夹 ----
  api.get('/api/folders', async (request) => listFolders(uid(request)));

  api.post('/api/folders', async (request, reply) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(40), parentId: z.string().max(40).nullable().optional() }), request.body, reply);
    if (!body) return;
    const userId = uid(request);
    const parentId = body.parentId ?? null;
    if (parentId && !db.prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ?').get(parentId, userId)) return bad(reply, '上级文件夹不存在');
    if (folderDepth(userId, parentId) >= MAX_DEPTH) return bad(reply, `文件夹最多 ${MAX_DEPTH} 层`);
    const id = newId('fd_');
    db.prepare('INSERT INTO folders (id, user_id, parent_id, name, created_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, parentId, body.name, now());
    return listFolders(userId).find((folder) => folder.id === id);
  });

  api.patch('/api/folders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = uid(request);
    if (!db.prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ?').get(id, userId)) return bad(reply, '文件夹不存在', 404);
    const body = parse(z.object({ name: z.string().trim().min(1).max(40).optional(), parentId: z.string().max(40).nullable().optional() }), request.body, reply);
    if (!body) return;
    if (body.name) db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(body.name, id);
    if (body.parentId !== undefined) {
      const parentId = body.parentId;
      if (parentId && !db.prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ?').get(parentId, userId)) return bad(reply, '上级文件夹不存在');
      if (parentId && isDescendant(userId, id, parentId)) return bad(reply, '不能移到自己的子文件夹里');
      if (folderDepth(userId, parentId) + subtreeHeight(userId, id) > MAX_DEPTH) return bad(reply, `文件夹最多 ${MAX_DEPTH} 层`);
      db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(parentId, id);
    }
    return listFolders(userId).find((folder) => folder.id === id);
  });

  /** 删除文件夹（含子文件夹）：里面的素材不删，变成"未归档" */
  api.delete('/api/folders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = uid(request);
    if (!db.prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ?').get(id, userId)) return bad(reply, '文件夹不存在', 404);
    const ids = (
      db
        .prepare(
          `WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id) SELECT id FROM tree`,
        )
        .all(id) as Row[]
    ).map((row) => String(row.id));
    const marks = ids.map(() => '?').join(',');
    db.prepare(`UPDATE assets SET folder_id = NULL WHERE user_id = ? AND folder_id IN (${marks})`).run(userId, ...ids);
    db.prepare(`DELETE FROM folders WHERE user_id = ? AND id IN (${marks})`).run(userId, ...ids);
    return { ok: true, removed: ids.length };
  });

  // ---- 标签 ----
  api.get('/api/tags', async (request) => listTags(uid(request)));

  api.patch('/api/tags/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = uid(request);
    const body = parse(z.object({ name: z.string().min(1).max(30) }), request.body, reply);
    if (!body) return;
    const name = normalizeTag(body.name);
    if (!name) return bad(reply, '标签名不能为空');
    const existing = db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ?').get(userId, name) as Row | undefined;
    if (existing && existing.id !== id) {
      // 改成已有的名字：合并两个标签
      db.prepare('INSERT OR IGNORE INTO asset_tags (asset_id, tag_id) SELECT asset_id, ? FROM asset_tags WHERE tag_id = ?').run(String(existing.id), id);
      db.prepare('DELETE FROM tags WHERE id = ? AND user_id = ?').run(id, userId);
    } else {
      db.prepare('UPDATE tags SET name = ? WHERE id = ? AND user_id = ?').run(name, id, userId);
    }
    const affected = db.prepare('SELECT asset_id FROM asset_tags WHERE tag_id = ?').all(String(existing?.id ?? id)) as Row[];
    indexAsset(...affected.map((row) => String(row.asset_id)));
    return listTags(userId);
  });

  api.delete('/api/tags/:id', async (request) => {
    const { id } = request.params as { id: string };
    const userId = uid(request);
    const affected = db.prepare('SELECT asset_id FROM asset_tags at JOIN tags t ON t.id = at.tag_id WHERE t.id = ? AND t.user_id = ?').all(id, userId) as Row[];
    db.prepare('DELETE FROM tags WHERE id = ? AND user_id = ?').run(id, userId);
    db.prepare('DELETE FROM asset_tags WHERE tag_id = ?').run(id);
    indexAsset(...affected.map((row) => String(row.asset_id)));
    return { ok: true };
  });

  // ---- 智能文件夹 ----
  api.get('/api/saved-searches', async (request) => {
    const rows = db.prepare('SELECT * FROM saved_searches WHERE user_id = ? ORDER BY created_at').all(uid(request)) as Row[];
    return rows.map((row): SavedSearch => ({ id: String(row.id), name: String(row.name), query: parseJson(row.query, {}) }));
  });

  api.post('/api/saved-searches', async (request, reply) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(40), query: assetQuerySchema }), request.body, reply);
    if (!body) return;
    const id = newId('ss_');
    db.prepare('INSERT INTO saved_searches (id, user_id, name, query, created_at) VALUES (?, ?, ?, ?, ?)').run(id, uid(request), body.name, JSON.stringify({ ...body.query, trash: undefined }), now());
    return { id, name: body.name, query: body.query } satisfies SavedSearch;
  });

  api.delete('/api/saved-searches/:id', async (request) => {
    const { id } = request.params as { id: string };
    db.prepare('DELETE FROM saved_searches WHERE id = ? AND user_id = ?').run(id, uid(request));
    return { ok: true };
  });

  // ---- 存储统计 ----
  api.get('/api/storage/usage', async (request): Promise<StorageUsage> => {
    const userId = uid(request);
    const live = 'user_id = ? AND deleted_at IS NULL';
    const total = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM assets WHERE ${live}`).get(userId) as Row;
    const trash = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM assets WHERE user_id = ? AND deleted_at IS NOT NULL').get(userId) as Row;
    const byKind = db.prepare(`SELECT kind, COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM assets WHERE ${live} GROUP BY kind ORDER BY b DESC`).all(userId) as Row[];
    const byMonth = db
      .prepare(
        `SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch', 'localtime') AS m, COUNT(*) AS n, COALESCE(SUM(size), 0) AS b
         FROM assets WHERE ${live} GROUP BY m ORDER BY m DESC LIMIT 24`,
      )
      .all(userId) as Row[];
    const byStory = db
      .prepare(
        `SELECT a.story_id, COALESCE(s.title, '未关联故事') AS title, COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS b
         FROM assets a LEFT JOIN stories s ON s.id = a.story_id WHERE a.user_id = ? AND a.deleted_at IS NULL
         GROUP BY a.story_id ORDER BY b DESC LIMIT 20`,
      )
      .all(userId) as Row[];
    const dup = db
      .prepare(
        `SELECT COUNT(*) AS groups, COALESCE(SUM(wasted), 0) AS wasted FROM (
           SELECT (COUNT(*) - 1) * MAX(COALESCE(size, 0)) AS wasted FROM assets WHERE ${live} AND sha256 IS NOT NULL
           GROUP BY sha256 HAVING COUNT(*) > 1)`,
      )
      .get(userId) as Row;
    return {
      total: { count: Number(total.n), bytes: Number(total.b) },
      byKind: byKind.map((row) => ({ kind: String(row.kind), count: Number(row.n), bytes: Number(row.b) })),
      byMonth: byMonth.map((row) => ({ month: String(row.m), count: Number(row.n), bytes: Number(row.b) })),
      byStory: byStory.map((row) => ({ storyId: (row.story_id as string | null) ?? null, title: String(row.title), count: Number(row.n), bytes: Number(row.b) })),
      trash: { count: Number(trash.n), bytes: Number(trash.b) },
      duplicates: { groups: Number(dup.groups), wasted: Number(dup.wasted) },
      disk: diskInfo(),
    };
  });

  // ---- 重复文件 ----
  api.get('/api/assets/duplicates', async (request) => {
    const userId = uid(request);
    const groups = db
      .prepare(
        `SELECT sha256 FROM assets WHERE user_id = ? AND deleted_at IS NULL AND sha256 IS NOT NULL
         GROUP BY sha256 HAVING COUNT(*) > 1 ORDER BY MAX(COALESCE(size, 0)) DESC LIMIT 200`,
      )
      .all(userId) as Row[];
    return groups.map((group) => {
      const rows = db.prepare('SELECT * FROM assets WHERE user_id = ? AND sha256 = ? AND deleted_at IS NULL ORDER BY seq').all(userId, String(group.sha256)) as Row[];
      return { sha256: String(group.sha256), keepId: String(pickKeeper(rows).id), assets: toAssets(rows) };
    });
  });

  /** 合并重复文件：每组只留一个，其余的引用全部改指向保留的那个，然后彻底删除 */
  api.post('/api/assets/duplicates/merge', async (request, reply) => {
    const body = parse(z.object({ sha256: z.array(z.string().length(64)).max(200).optional() }), request.body ?? {}, reply);
    if (!body) return;
    const userId = uid(request);
    const hashes =
      body.sha256 ??
      (
        db
          .prepare('SELECT sha256 FROM assets WHERE user_id = ? AND deleted_at IS NULL AND sha256 IS NOT NULL GROUP BY sha256 HAVING COUNT(*) > 1')
          .all(userId) as Row[]
      ).map((row) => String(row.sha256));
    let removed = 0;
    for (const hash of hashes) {
      const rows = db.prepare('SELECT * FROM assets WHERE user_id = ? AND sha256 = ? AND deleted_at IS NULL').all(userId, hash) as Row[];
      removed += await mergeGroup(userId, rows);
    }
    return { groups: hashes.length, removed };
  });

  /** 单个素材的完整信息（详情抽屉）：资产本身、来源任务、所在文件夹路径 */
  api.get('/api/assets/:id/detail', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = uid(request);
    const row = getAssetRow(id);
    if (!row || row.user_id !== userId) return bad(reply, '素材不存在', 404);
    const task = row.task_id ? (db.prepare('SELECT id, title, type, status, created_at, finished_at, recipe FROM tasks WHERE id = ?').get(String(row.task_id)) as Row | undefined) : undefined;
    const pathNames: string[] = [];
    let folderId = (row.folder_id as string | null) ?? null;
    while (folderId && pathNames.length < 8) {
      const folder = db.prepare('SELECT name, parent_id FROM folders WHERE id = ?').get(folderId) as Row | undefined;
      if (!folder) break;
      pathNames.unshift(String(folder.name));
      folderId = (folder.parent_id as string | null) ?? null;
    }
    const story = row.story_id ? (db.prepare('SELECT id, title FROM stories WHERE id = ?').get(String(row.story_id)) as Row | undefined) : undefined;
    return {
      asset: loadAsset(id),
      codec: (row.codec as string | null) ?? null,
      sha256: (row.sha256 as string | null) ?? null,
      meta: parseJson(row.meta, null),
      folderPath: pathNames,
      story: story ? { id: String(story.id), title: String(story.title) } : null,
      task: task
        ? { id: String(task.id), title: String(task.title), type: String(task.type), status: String(task.status), createdAt: Number(task.created_at), finishedAt: task.finished_at == null ? null : Number(task.finished_at) }
        : null,
    };
  });
}
