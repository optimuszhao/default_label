// 资产：列表、上传、收藏、删除、文件下载
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, type Row } from '../db.ts';
import { absoluteFile, ALLOWED_UPLOAD_MIME, deleteAssetFile, saveAsset } from '../files.ts';
import { getAssetRow, toAsset } from '../repo.ts';
import { bad, parse, uid } from './common.ts';

export async function assetRoutes(api: FastifyInstance): Promise<void> {
  api.get('/api/assets', async (request) => {
    const query = request.query as { kind?: string; storyId?: string; favorite?: string; source?: string; before?: string; limit?: string };
    const where = ['user_id = ?'];
    const args: (string | number)[] = [uid(request)];
    if (query.kind) {
      where.push('kind = ?');
      args.push(query.kind);
    }
    if (query.source) {
      where.push('source = ?');
      args.push(query.source);
    }
    if (query.storyId) {
      where.push('story_id = ?');
      args.push(query.storyId);
    }
    if (query.favorite === '1') where.push('favorite = 1');
    // 游标是上一页最后一条的「创建时间:id」，同一毫秒写入的多条也不会漏（只给时间也兼容）
    if (query.before) {
      const [ts, id] = query.before.split(':');
      if (id) {
        where.push('(created_at < ? OR (created_at = ? AND id < ?))');
        args.push(Number(ts), Number(ts), id);
      } else {
        where.push('created_at < ?');
        args.push(Number(ts));
      }
    }
    const limit = Math.min(Number(query.limit) || 60, 500);
    const rows = db
      .prepare(`SELECT * FROM assets WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${limit}`)
      .all(...args) as Row[];
    return rows.map(toAsset);
  });

  api.post('/api/assets/upload', async (request, reply) => {
    const part = await request.file();
    if (!part) return bad(reply, '没有收到文件');
    if (!ALLOWED_UPLOAD_MIME.has(part.mimetype)) return bad(reply, '仅支持 PNG / JPG / WEBP / GIF 图片或 MP4 / WEBM 视频');
    const data = await part.toBuffer();
    const fields = part.fields as Record<string, { value?: string } | undefined>;
    const width = Number(fields.width?.value) || null;
    const height = Number(fields.height?.value) || null;
    return saveAsset({
      userId: uid(request),
      kind: part.mimetype.startsWith('video/') ? 'video' : 'image',
      source: 'upload',
      mime: part.mimetype,
      data,
      width,
      height,
    });
  });

  api.patch('/api/assets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getAssetRow(id);
    if (!row || row.user_id !== uid(request)) return bad(reply, '素材不存在', 404);
    const body = parse(z.object({ favorite: z.boolean() }), request.body, reply);
    if (!body) return;
    db.prepare('UPDATE assets SET favorite = ? WHERE id = ?').run(body.favorite ? 1 : 0, id);
    return toAsset(getAssetRow(id)!);
  });

  api.delete('/api/assets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getAssetRow(id);
    if (!row || row.user_id !== uid(request)) return bad(reply, '素材不存在', 404);
    db.prepare('DELETE FROM assets WHERE id = ?').run(id);
    await deleteAssetFile(String(row.file));
    return { ok: true };
  });

  api.get('/api/files/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getAssetRow(id);
    if (!row || row.user_id !== uid(request)) return bad(reply, '文件不存在', 404);
    const file = absoluteFile(String(row.file));
    if (!fs.existsSync(file)) return bad(reply, '文件不存在', 404);
    // 文件内容不可变，可长期缓存
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    return reply.sendFile(String(row.file), absoluteFile(''));
  });
}
