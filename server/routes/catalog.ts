// 预设、模板、收藏、我的提示词、创作流水
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { allPresets, allTemplates, catalogVersion, templateScores } from '../catalog.ts';
import { db, newId, now, type Row } from '../db.ts';
import { toAssets, toTask } from '../repo.ts';
import { bad, parse, uid } from './common.ts';

export async function catalogRoutes(api: FastifyInstance): Promise<void> {
  // 预设很少变：带 ETag，没变时返回 304
  api.get('/api/presets', async (request, reply) => {
    const etag = `"p${catalogVersion()}"`;
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    reply.header('etag', etag).header('cache-control', 'private, no-cache');
    return allPresets().filter((preset) => preset.enabled);
  });

  api.get('/api/templates', async (request) => {
    const favorites = new Set(
      (db.prepare("SELECT ref FROM favorites WHERE user_id = ? AND kind = 'template'").all(uid(request)) as Row[]).map((row) => String(row.ref)),
    );
    const scores = templateScores();
    return allTemplates()
      .filter((template) => template.enabled)
      .map((template) => ({
        ...template,
        hot: Math.round((scores.get(template.id)?.hot ?? 0) * 100) / 100,
        uses: scores.get(template.id)?.uses ?? 0,
        favorite: favorites.has(template.id),
      }));
  });

  api.put('/api/favorites', async (request, reply) => {
    const body = parse(z.object({ kind: z.enum(['template', 'preset']), ref: z.string().min(1).max(80), on: z.boolean() }), request.body, reply);
    if (!body) return;
    if (body.on) {
      db.prepare('INSERT OR IGNORE INTO favorites (user_id, kind, ref, created_at) VALUES (?, ?, ?, ?)').run(uid(request), body.kind, body.ref, now());
    } else {
      db.prepare('DELETE FROM favorites WHERE user_id = ? AND kind = ? AND ref = ?').run(uid(request), body.kind, body.ref);
    }
    return { ok: true };
  });

  api.get('/api/favorites', async (request) => {
    const rows = db.prepare('SELECT kind, ref FROM favorites WHERE user_id = ? ORDER BY created_at DESC').all(uid(request)) as Row[];
    return rows.map((row) => ({ kind: String(row.kind), ref: String(row.ref) }));
  });

  // ---- 我的提示词 ----
  api.get('/api/prompts', async (request) => {
    const rows = db.prepare('SELECT * FROM user_prompts WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').all(uid(request)) as Row[];
    return rows.map((row) => ({ id: String(row.id), name: String(row.name), body: String(row.body), mode: String(row.mode), createdAt: Number(row.created_at) }));
  });

  api.post('/api/prompts', async (request, reply) => {
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(40), body: z.string().trim().min(1).max(4000), mode: z.enum(['image', 'video']) }),
      request.body,
      reply,
    );
    if (!body) return;
    const id = newId('up_');
    const ts = now();
    db.prepare('INSERT INTO user_prompts (id, user_id, name, body, mode, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, uid(request), body.name, body.body, body.mode, ts);
    return { id, ...body, createdAt: ts };
  });

  api.delete('/api/prompts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = db.prepare('DELETE FROM user_prompts WHERE id = ? AND user_id = ?').run(id, uid(request));
    if (!result.changes) return bad(reply, '提示词不存在', 404);
    return { ok: true };
  });

  // ---- 最近使用的配方（去重后 30 条） ----
  api.get('/api/recipes/recent', async (request) => {
    const rows = db
      .prepare("SELECT recipe, prompt, type, created_at FROM tasks WHERE user_id = ? AND recipe IS NOT NULL ORDER BY created_at DESC LIMIT 200")
      .all(uid(request)) as Row[];
    const seen = new Set<string>();
    const out: { recipe: unknown; prompt: string; createdAt: number }[] = [];
    for (const row of rows) {
      const recipe = JSON.parse(String(row.recipe)) as { text?: string; templateId?: string; vars?: unknown; presets?: unknown; mode?: string };
      const key = JSON.stringify([recipe.mode, recipe.text, recipe.templateId, recipe.vars, recipe.presets]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ recipe, prompt: String(row.prompt), createdAt: Number(row.created_at) });
      if (out.length >= 30) break;
    }
    return out;
  });

  // ---- 创作流水：游标分页，可以一直翻到最早的作品 ----
  api.get('/api/feed', async (request) => {
    const query = request.query as { before?: string; limit?: string; kind?: string; favorite?: string; q?: string; storyId?: string };
    const where = ['t.user_id = ?'];
    const args: (string | number)[] = [uid(request)];
    if (query.kind === 'image') where.push("t.type IN ('t2i', 'i2i')");
    if (query.kind === 'video') where.push("t.type IN ('t2v', 'i2v')");
    if (query.favorite === '1') where.push('EXISTS (SELECT 1 FROM assets a WHERE a.task_id = t.id AND a.favorite = 1)');
    if (query.q?.trim()) {
      where.push('(t.prompt LIKE ? OR t.title LIKE ?)');
      args.push(`%${query.q.trim()}%`, `%${query.q.trim()}%`);
    }
    if (query.before) {
      const [ts, id] = query.before.split(':');
      where.push('(t.created_at < ? OR (t.created_at = ? AND t.id < ?))');
      args.push(Number(ts), Number(ts), id ?? '');
    }
    const limit = Math.min(Number(query.limit) || 30, 100);
    const rows = db
      .prepare(`SELECT t.* FROM tasks t WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC, t.id DESC LIMIT ${limit + 1}`)
      .all(...args) as Row[];
    const page = rows.slice(0, limit).map(toTask);
    // 一并返回产物和参考图，前端不必逐个再查
    const assetIds = new Set<string>();
    for (const task of page) {
      for (const id of task.outputAssetIds) assetIds.add(id);
      for (const id of task.inputs.referenceAssetIds ?? []) assetIds.add(id);
      if (task.inputs.firstFrameAssetId) assetIds.add(task.inputs.firstFrameAssetId);
    }
    const ids = [...assetIds];
    const assets = ids.length
      ? toAssets(db.prepare(`SELECT * FROM assets WHERE user_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).all(uid(request), ...ids) as Row[])
      : [];
    const last = page.at(-1);
    return { tasks: page, assets, next: rows.length > limit && last ? `${last.createdAt}:${last.id}` : null };
  });
}
