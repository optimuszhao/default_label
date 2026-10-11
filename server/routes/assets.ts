// 资产库：查询、分面、组织（收藏 / 评分 / 标记 / 备注 / 文件夹 / 标签）、批量操作、回收站、
// 使用情况、血缘、上传（单次和分片断点续传）、截帧、打包下载、文件（原图 / 缩略图 / 封面）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AssetQuery } from '../../shared/types.ts';
import { publish } from '../bus.ts';
import { config } from '../config.ts';
import { db, newId, now, type Row } from '../db.ts';
import { absoluteFile, ALLOWED_UPLOAD_MIME, indexAsset, newTempFile, purgeAsset, thumbFile } from '../files.ts';
import { frameFromAsset } from '../library/frame.ts';
import { applyCursor, assetQuerySchema, buildWhere, nextCursor, orderBy, queryFromParams } from '../library/query.ts';
import { addTags, removeTags, setTags } from '../library/tags.ts';
import { finalizeUpload } from '../library/upload.ts';
import { assetUsage } from '../library/usage.ts';
import { uniqueNames, writeZip, type ZipEntry } from '../media/zip.ts';
import { getAssetRow, loadAsset, toAssets } from '../repo.ts';
import { bad, parse, uid } from './common.ts';

const UNSUPPORTED = '仅支持 PNG / JPG / WEBP / GIF 图片、MP4 / WEBM / MOV 视频，或 MP3 / WAV / M4A / AAC / OGG / FLAC 音频';
/** 分片大小：5 MB */
export const CHUNK_SIZE = 5 * 1024 * 1024;
/** "按条件全选"一次最多处理的素材数 */
const MAX_BATCH = 20_000;

function owned(request: FastifyRequest, reply: FastifyReply): Row | null {
  const { id } = request.params as { id: string };
  const row = getAssetRow(id);
  if (!row || row.user_id !== uid(request)) {
    void bad(reply, '素材不存在', 404);
    return null;
  }
  return row;
}

/** 批量操作的目标：给 id 列表时只取属于自己的；给查询条件时按条件全选 */
function resolveTargets(userId: string, ids: string[] | undefined, query: AssetQuery | undefined, includeTrash = false): string[] {
  if (ids?.length) {
    const out: string[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const trash = includeTrash ? '' : ' AND deleted_at IS NULL';
      const rows = db
        .prepare(`SELECT id FROM assets WHERE user_id = ?${trash} AND id IN (${chunk.map(() => '?').join(',')})`)
        .all(userId, ...chunk) as Row[];
      out.push(...rows.map((row) => String(row.id)));
    }
    return out;
  }
  if (query) {
    const where = buildWhere(userId, query);
    return (db.prepare(`SELECT a.id FROM assets a WHERE ${where.sql} LIMIT ${MAX_BATCH}`).all(...where.args) as Row[]).map((row) => String(row.id));
  }
  return [];
}

function ownsFolder(userId: string, folderId: string | null | undefined): boolean {
  if (!folderId) return true;
  return Boolean(db.prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ?').get(folderId, userId));
}

function inChunks(ids: string[], run: (chunk: string[], marks: string) => void): void {
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    run(chunk, chunk.map(() => '?').join(','));
  }
}

/** 移入回收站：被排队或生成中的任务引用的素材跳过，返回被拦下的 */
function trashAssets(userId: string, ids: string[]): { trashed: string[]; blocked: { id: string; reason: string }[] } {
  const trashed: string[] = [];
  const blocked: { id: string; reason: string }[] = [];
  const ts = now();
  for (const id of ids) {
    const usage = assetUsage(userId, id);
    if (usage.activeTasks.length) {
      blocked.push({ id, reason: `正在被任务「${usage.activeTasks[0].title}」使用` });
      continue;
    }
    db.prepare('UPDATE assets SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(ts, id);
    trashed.push(id);
  }
  if (trashed.length) publish(userId, { type: 'assets-trashed', ids: trashed, at: ts });
  return { trashed, blocked };
}

const exportTokens = new Map<string, { userId: string; ids: string[]; name: string; expires: number }>();

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function extOf(file: string): string {
  return path.extname(file).slice(1) || 'bin';
}

function dateLabel(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const patchSchema = z.object({
  favorite: z.boolean().optional(),
  rating: z.number().int().min(0).max(5).optional(),
  flag: z.enum(['pick', 'reject']).nullable().optional(),
  note: z.string().max(2000).optional(),
  folderId: z.string().max(40).nullable().optional(),
  tags: z.array(z.string().max(30)).max(30).optional(),
});

const batchSchema = z.object({
  ids: z.array(z.string().max(40)).max(MAX_BATCH).optional(),
  query: assetQuerySchema.optional(),
  action: z.enum(['favorite', 'rating', 'flag', 'move', 'addTags', 'removeTags', 'trash', 'restore', 'purge']),
  value: z.unknown().optional(),
});

export async function assetRoutes(api: FastifyInstance): Promise<void> {
  // 分片上传的请求体是原始字节流，直接交给路由按流写盘，不经过 JSON 解析和 bodyLimit
  api.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

  api.get('/api/assets', async (request) => {
    const params = request.query as Record<string, string | undefined>;
    const query = queryFromParams(params);
    const where = buildWhere(uid(request), query);
    const limit = Math.min(Math.max(Number(params.limit) || 60, 1), 500);
    if (params.page !== '1' && (!query.sort || query.sort === 'new')) {
      // 旧客户端：直接拿数组，游标是「创建时间:id」（只给时间也兼容），按创建时间排序
      if (params.before) {
        const [ts, id] = params.before.split(':');
        if (id) {
          where.sql += ' AND (a.created_at < ? OR (a.created_at = ? AND a.id < ?))';
          where.args.push(Number(ts), Number(ts), id);
        } else {
          where.sql += ' AND a.created_at < ?';
          where.args.push(Number(ts));
        }
      }
      const rows = db.prepare(`SELECT a.* FROM assets a WHERE ${where.sql} ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit}`).all(...where.args) as Row[];
      return toAssets(rows);
    }
    const { offset } = applyCursor(query, params.cursor, where);
    const rows = db
      .prepare(`SELECT a.* FROM assets a WHERE ${where.sql} ORDER BY ${orderBy(query)} LIMIT ${limit} OFFSET ${offset}`)
      .all(...where.args) as Row[];
    const items = toAssets(rows);
    // 旧客户端直接拿数组；新客户端传 page=1 拿 {items, next}
    if (params.page === '1') return { items, next: nextCursor(query, rows, limit, offset) };
    return items;
  });

  api.get('/api/assets/facets', async (request) => {
    const query = queryFromParams(request.query as Record<string, string | undefined>);
    const userId = uid(request);
    const where = buildWhere(userId, query);
    const count = (extra = '', args: (string | number)[] = []) =>
      Number((db.prepare(`SELECT COUNT(*) AS n FROM assets a WHERE ${where.sql}${extra}`).get(...where.args, ...args) as Row).n);
    const group = (column: string) =>
      Object.fromEntries(
        (db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM assets a WHERE ${where.sql} GROUP BY ${column}`).all(...where.args) as Row[]).map((row) => [
          String(row.k ?? 'none'),
          Number(row.n),
        ]),
      );
    const tags = db
      .prepare(
        `SELECT t.id, t.name, COUNT(*) AS n FROM asset_tags at JOIN tags t ON t.id = at.tag_id JOIN assets a ON a.id = at.asset_id
         WHERE ${where.sql} GROUP BY t.id ORDER BY n DESC, t.name LIMIT 50`,
      )
      .all(...where.args) as Row[];
    const stories = db
      .prepare(
        `SELECT s.id, s.title, COUNT(*) AS n FROM assets a JOIN stories s ON s.id = a.story_id
         WHERE ${where.sql} GROUP BY s.id ORDER BY n DESC LIMIT 50`,
      )
      .all(...where.args) as Row[];
    return {
      total: count(),
      kinds: group('a.kind'),
      sources: group('a.source'),
      flags: group('a.flag'),
      favorite: count(' AND a.favorite = 1'),
      ratings: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, count(' AND a.rating >= ?', [n])])),
      tags: tags.map((row) => ({ id: String(row.id), name: String(row.name), count: Number(row.n) })),
      stories: stories.map((row) => ({ id: String(row.id), title: String(row.title), count: Number(row.n) })),
    };
  });

  api.get('/api/assets/:id', async (request, reply) => {
    const row = owned(request, reply);
    if (!row) return;
    return loadAsset(String(row.id));
  });

  api.get('/api/assets/:id/usage', async (request, reply) => {
    const row = owned(request, reply);
    if (!row) return;
    return assetUsage(uid(request), String(row.id));
  });

  api.post('/api/assets/usage', async (request, reply) => {
    const body = parse(z.object({ ids: z.array(z.string().max(40)).max(500) }), request.body, reply);
    if (!body) return;
    const ids = resolveTargets(uid(request), body.ids, undefined, true);
    return ids.map((id) => assetUsage(uid(request), id)).filter((usage) => usage.activeTasks.length || usage.stories.length);
  });

  /** 血缘：向上最多 8 代来源，向下全部直接派生 */
  api.get('/api/assets/:id/lineage', async (request, reply) => {
    const row = owned(request, reply);
    if (!row) return;
    const userId = uid(request);
    const parents: Row[] = [];
    let parentId = row.parent_asset_id as string | null;
    while (parentId && parents.length < 8) {
      const parent = getAssetRow(parentId);
      if (!parent || parent.user_id !== userId) break;
      parents.push(parent);
      parentId = parent.parent_asset_id as string | null;
    }
    const children = db.prepare('SELECT * FROM assets WHERE parent_asset_id = ? AND user_id = ? ORDER BY seq DESC LIMIT 100').all(String(row.id), userId) as Row[];
    return { parents: toAssets(parents), children: toAssets(children) };
  });

  api.patch('/api/assets/:id', async (request, reply) => {
    const row = owned(request, reply);
    if (!row) return;
    const body = parse(patchSchema, request.body, reply);
    if (!body) return;
    const userId = uid(request);
    const id = String(row.id);
    if (body.folderId !== undefined && !ownsFolder(userId, body.folderId)) return bad(reply, '文件夹不存在');
    const fields: Record<string, unknown> = {};
    if (body.favorite !== undefined) fields.favorite = body.favorite ? 1 : 0;
    if (body.rating !== undefined) fields.rating = body.rating;
    if (body.flag !== undefined) fields.flag = body.flag;
    if (body.note !== undefined) fields.note = body.note;
    if (body.folderId !== undefined) fields.folder_id = body.folderId;
    const keys = Object.keys(fields);
    if (keys.length) db.prepare(`UPDATE assets SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((key) => fields[key] as never), id);
    if (body.tags) setTags(userId, id, body.tags);
    else if (body.note !== undefined) indexAsset(id);
    const asset = loadAsset(id)!;
    publish(userId, { type: 'asset', asset });
    return asset;
  });

  api.post('/api/assets/batch', async (request, reply) => {
    const body = parse(batchSchema, request.body, reply);
    if (!body) return;
    const userId = uid(request);
    const inTrash = body.action === 'restore' || body.action === 'purge';
    const ids = resolveTargets(userId, body.ids, body.query ? { ...body.query, trash: inTrash || body.query.trash } : undefined, inTrash);
    if (!ids.length) return { count: 0, blocked: [] };
    const value = body.value;
    switch (body.action) {
      case 'favorite':
        inChunks(ids, (chunk, marks) => db.prepare(`UPDATE assets SET favorite = ? WHERE id IN (${marks})`).run(value ? 1 : 0, ...chunk));
        break;
      case 'rating': {
        const rating = z.number().int().min(0).max(5).safeParse(value);
        if (!rating.success) return bad(reply, '评分应为 0–5');
        inChunks(ids, (chunk, marks) => db.prepare(`UPDATE assets SET rating = ? WHERE id IN (${marks})`).run(rating.data, ...chunk));
        break;
      }
      case 'flag': {
        const flag = z.enum(['pick', 'reject']).nullable().safeParse(value ?? null);
        if (!flag.success) return bad(reply, '标记只能是挑选、淘汰或清除');
        inChunks(ids, (chunk, marks) => db.prepare(`UPDATE assets SET flag = ? WHERE id IN (${marks})`).run(flag.data, ...chunk));
        break;
      }
      case 'move': {
        const folderId = (value as string | null | undefined) ?? null;
        if (!ownsFolder(userId, folderId)) return bad(reply, '文件夹不存在');
        inChunks(ids, (chunk, marks) => db.prepare(`UPDATE assets SET folder_id = ? WHERE id IN (${marks})`).run(folderId, ...chunk));
        break;
      }
      case 'addTags':
      case 'removeTags': {
        const names = z.array(z.string().max(30)).min(1).max(20).safeParse(value);
        if (!names.success) return bad(reply, '请给出标签');
        (body.action === 'addTags' ? addTags : removeTags)(userId, ids, names.data);
        break;
      }
      case 'trash': {
        const result = trashAssets(userId, ids);
        return { count: result.trashed.length, blocked: result.blocked };
      }
      case 'restore':
        inChunks(ids, (chunk, marks) => db.prepare(`UPDATE assets SET deleted_at = NULL WHERE id IN (${marks})`).run(...chunk));
        publish(userId, { type: 'assets-trashed', ids, at: null });
        break;
      case 'purge': {
        for (const id of ids) {
          const row = getAssetRow(id);
          if (row?.deleted_at != null) await purgeAsset(row);
        }
        publish(userId, { type: 'assets-removed', ids });
        break;
      }
    }
    return { count: ids.length, blocked: [] };
  });

  /** 删除：第一次进回收站；已经在回收站里的彻底删除 */
  api.delete('/api/assets/:id', async (request, reply) => {
    const row = owned(request, reply);
    if (!row) return;
    const userId = uid(request);
    if (row.deleted_at != null) {
      await purgeAsset(row);
      publish(userId, { type: 'assets-removed', ids: [String(row.id)] });
      return { ok: true, purged: true };
    }
    const result = trashAssets(userId, [String(row.id)]);
    if (result.blocked.length) return bad(reply, `${result.blocked[0].reason}，请先取消或等待任务完成`, 409);
    return { ok: true, trashed: true };
  });

  api.post('/api/assets/trash/empty', async (request) => {
    const userId = uid(request);
    const rows = db.prepare('SELECT * FROM assets WHERE user_id = ? AND deleted_at IS NOT NULL').all(userId) as Row[];
    for (const row of rows) await purgeAsset(row);
    if (rows.length) publish(userId, { type: 'assets-removed', ids: rows.map((row) => String(row.id)) });
    return { count: rows.length };
  });

  // ---- 上传 ----

  /** 单次上传（旧接口，表单 multipart）：流式写到临时文件，不整段读进内存 */
  api.post('/api/assets/upload', async (request, reply) => {
    const part = await request.file();
    if (!part) return bad(reply, '没有收到文件');
    if (!ALLOWED_UPLOAD_MIME.has(part.mimetype)) return bad(reply, UNSUPPORTED);
    const temp = await newTempFile('upload');
    try {
      await pipeline(part.file, fs.createWriteStream(temp));
      if (part.file.truncated) {
        await fsp.rm(temp, { force: true });
        return bad(reply, `文件超过 ${config.maxUploadMb} MB，请用资产库的上传（支持大文件和断点续传）`, 413);
      }
      const fields = part.fields as Record<string, { value?: string } | undefined>;
      const result = await finalizeUpload(uid(request), temp, {
        filename: part.filename,
        mime: part.mimetype,
        width: Number(fields.width?.value) || null,
        height: Number(fields.height?.value) || null,
        folderId: fields.folderId?.value || null,
      });
      return result.asset;
    } catch (error) {
      await fsp.rm(temp, { force: true });
      throw error;
    }
  });

  /** 分片上传第 1 步：登记文件，返回分片大小和已收到的字节数（断点续传时用同一个 id 继续） */
  api.post('/api/uploads', async (request, reply) => {
    const body = parse(
      z.object({ filename: z.string().min(1).max(200), mime: z.string().max(80), size: z.number().int().min(1) }),
      request.body,
      reply,
    );
    if (!body) return;
    if (!ALLOWED_UPLOAD_MIME.has(body.mime)) return bad(reply, UNSUPPORTED);
    const limit = config.uploadMaxMb * 1024 * 1024;
    if (body.size > limit) return bad(reply, `文件不能超过 ${config.uploadMaxMb} MB`, 413);
    const id = newId('up_');
    const temp = await newTempFile('upload');
    await fsp.writeFile(temp, '');
    db.prepare('INSERT INTO uploads (id, user_id, filename, mime, size, received, temp_file, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)').run(
      id,
      uid(request),
      body.filename,
      body.mime,
      body.size,
      temp,
      now(),
      now(),
    );
    return { id, chunkSize: CHUNK_SIZE, received: 0 };
  });

  function ownedUpload(request: FastifyRequest, reply: FastifyReply): Row | null {
    const { id } = request.params as { id: string };
    const row = db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(id, uid(request)) as Row | undefined;
    if (!row) {
      void bad(reply, '上传已过期，请重新选择文件', 404);
      return null;
    }
    return row;
  }

  api.get('/api/uploads/:id', async (request, reply) => {
    const row = ownedUpload(request, reply);
    if (!row) return;
    return { id: row.id, chunkSize: CHUNK_SIZE, received: Number(row.received), size: Number(row.size) };
  });

  /** 第 2 步：按顺序发送分片（PUT ?offset=已收到字节数，请求体是原始字节） */
  api.put('/api/uploads/:id', async (request, reply) => {
    const row = ownedUpload(request, reply);
    if (!row) return;
    const offset = Number((request.query as { offset?: string }).offset);
    const received = Number(row.received);
    if (offset !== received) return reply.code(409).send({ error: '分片顺序不对', received, requestId: request.id });
    const body = request.body as NodeJS.ReadableStream | undefined;
    if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function') return bad(reply, '请以 application/octet-stream 发送分片');
    const size = Number(row.size);
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > CHUNK_SIZE * 2 || offset + bytes > size) callback(new Error('分片过大'));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(body, counter, fs.createWriteStream(String(row.temp_file), { flags: 'r+', start: offset }));
    } catch (error) {
      return bad(reply, (error as Error).message);
    }
    db.prepare('UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?').run(offset + bytes, now(), String(row.id));
    return { received: offset + bytes };
  });

  /** 第 3 步：收齐后落地为素材（相同文件之前上传过时直接返回已有的） */
  api.post('/api/uploads/:id/complete', async (request, reply) => {
    const row = ownedUpload(request, reply);
    if (!row) return;
    const body = parse(z.object({ folderId: z.string().max(40).nullable().optional(), storyId: z.string().max(40).nullable().optional() }).default({}), request.body ?? {}, reply);
    if (!body) return;
    if (Number(row.received) !== Number(row.size)) return bad(reply, `还没传完（${row.received}/${row.size}）`);
    const userId = uid(request);
    const folderId = ownsFolder(userId, body.folderId) ? body.folderId : null;
    const story = body.storyId ? (db.prepare('SELECT user_id FROM stories WHERE id = ?').get(body.storyId) as Row | undefined) : undefined;
    db.prepare('DELETE FROM uploads WHERE id = ?').run(String(row.id));
    return finalizeUpload(userId, String(row.temp_file), {
      filename: String(row.filename),
      mime: String(row.mime),
      folderId,
      storyId: story?.user_id === userId ? body.storyId : null,
    });
  });

  api.delete('/api/uploads/:id', async (request, reply) => {
    const row = ownedUpload(request, reply);
    if (!row) return;
    await fsp.rm(String(row.temp_file), { force: true });
    db.prepare('DELETE FROM uploads WHERE id = ?').run(String(row.id));
    return { ok: true };
  });

  // ---- 截帧 ----

  api.post('/api/assets/:id/frame', async (request, reply) => {
    const row = owned(request, reply);
    if (!row) return;
    const body = parse(z.object({ at: z.union([z.number().min(0).max(36_000), z.literal('last')]) }), request.body, reply);
    if (!body) return;
    try {
      return await frameFromAsset(uid(request), String(row.id), body.at);
    } catch (error) {
      return bad(reply, (error as Error).message);
    }
  });

  // ---- 打包下载 ----

  /** 先登记要打包的素材，拿一个 10 分钟有效的下载地址（浏览器用普通链接下载，支持大文件） */
  api.post('/api/assets/export', async (request, reply) => {
    const body = parse(z.object({ ids: z.array(z.string().max(40)).max(MAX_BATCH).optional(), query: assetQuerySchema.optional(), name: z.string().max(60).optional() }), request.body, reply);
    if (!body) return;
    const userId = uid(request);
    const ids = resolveTargets(userId, body.ids, body.query, Boolean(body.query?.trash));
    if (!ids.length) return bad(reply, '没有可下载的素材');
    let bytes = 0;
    inChunks(ids, (chunk, marks) => {
      bytes += Number((db.prepare(`SELECT COALESCE(SUM(size), 0) AS n FROM assets WHERE id IN (${marks})`).get(...chunk) as Row).n);
    });
    for (const [token, item] of exportTokens) if (item.expires < Date.now()) exportTokens.delete(token);
    const token = newId('ex_');
    const name = `${(body.name || '织影素材').replace(/[\\/:*?"<>|]/g, '_')}-${dateLabel(now())}.zip`;
    exportTokens.set(token, { userId, ids, name, expires: Date.now() + 10 * 60_000 });
    return { url: `/api/assets/export/${token}`, count: ids.length, bytes };
  });

  api.get('/api/assets/export/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const item = exportTokens.get(token);
    if (!item || item.userId !== uid(request) || item.expires < Date.now()) return bad(reply, '下载链接已过期，请重新打包', 404);
    const folders = new Map((db.prepare('SELECT id, name FROM folders WHERE user_id = ?').all(item.userId) as Row[]).map((row) => [String(row.id), String(row.name)]));
    const unique = uniqueNames();
    const manifest: Record<string, unknown>[] = [];
    async function* entries(): AsyncGenerator<ZipEntry> {
      for (let i = 0; i < item!.ids.length; i += 200) {
        const chunk = item!.ids.slice(i, i + 200);
        const rows = toAssets(db.prepare(`SELECT * FROM assets WHERE user_id = ? AND id IN (${chunk.map(() => '?').join(',')})`).all(item!.userId, ...chunk) as Row[]);
        const files = new Map((db.prepare(`SELECT id, file FROM assets WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Row[]).map((row) => [String(row.id), String(row.file)]));
        for (const asset of rows) {
          const file = absoluteFile(files.get(asset.id)!);
          if (!fs.existsSync(file)) continue;
          const folder = asset.folderId ? folders.get(asset.folderId) : null;
          const base = asset.filename ? asset.filename.replace(/\.[^.]+$/, '') : `${dateLabel(asset.createdAt)}-${asset.kind}`;
          const name = unique(`${folder ? `${folder}/` : ''}${base}.${extOf(file)}`);
          manifest.push({
            file: name,
            id: asset.id,
            kind: asset.kind,
            prompt: asset.prompt,
            seed: asset.gen?.seed ?? null,
            width: asset.width,
            height: asset.height,
            duration: asset.duration,
            rating: asset.rating,
            tags: asset.tags,
            note: asset.note,
            createdAt: new Date(asset.createdAt).toISOString(),
            aigc: asset.source === 'generated',
          });
          yield { name, file, mtime: new Date(asset.createdAt) };
        }
      }
      yield { name: 'manifest.json', data: JSON.stringify({ generator: '织影 Weave', exportedAt: new Date().toISOString(), note: '标记 aigc=true 的素材由 AI 生成', items: manifest }, null, 2) };
    }
    const stream = new PassThrough();
    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());
    void writeZip(entries(), stream, controller.signal)
      .then(() => stream.end())
      .catch((error) => stream.destroy(error as Error));
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', contentDisposition(item.name));
    return reply.send(stream);
  });

  // ---- 文件 ----

  /** 原文件；?variant=thumb 缩略图、poster 视频封面（没有时退回原文件）；?download=1 作为附件下载 */
  api.get('/api/files/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { variant?: string; download?: string };
    const row = getAssetRow(id);
    if (!row || row.user_id !== uid(request)) return bad(reply, '文件不存在', 404);
    // 文件内容不可变，可长期缓存
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    const variant = query.variant === 'thumb' ? row.thumb : query.variant === 'poster' ? row.poster : null;
    if (variant && fs.existsSync(thumbFile(String(variant)))) return reply.sendFile(String(variant), thumbFile(''));
    const file = absoluteFile(String(row.file));
    if (!fs.existsSync(file)) return bad(reply, '文件不存在', 404);
    if (query.download === '1') {
      const name = (row.filename as string | null) ?? `${dateLabel(Number(row.created_at))}-${row.kind}.${extOf(file)}`;
      reply.header('content-disposition', contentDisposition(name));
    }
    return reply.sendFile(String(row.file), absoluteFile(''));
  });
}
