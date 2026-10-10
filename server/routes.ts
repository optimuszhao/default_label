import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AssistKind, ServerEvent, StoryData, StorySummary, Task } from '../shared/types.ts';
import { runAssist } from './assist.ts';
import { createUser, endSession, findUserByEmail, hashPassword, requireUser, startSession, verifyPassword } from './auth.ts';
import { subscribe } from './bus.ts';
import { config } from './config.ts';
import { db, newId, now, parseJson, type Row } from './db.ts';
import { absoluteFile, ALLOWED_UPLOAD_MIME, deleteAssetFile, saveAsset } from './files.ts';
import { capabilities, getHealth, provider } from './providers/index.ts';
import { clampDuration, resolveSize } from '../shared/operator.ts';
import { assetUrl, getAssetRow, getTask, getTaskOwner, getUserSettings, toAsset, toTask, toUser } from './repo.ts';
import { kickScheduler } from './scheduler.ts';

function bad(reply: FastifyReply, message: string, code = 400) {
  return reply.code(code).send({ error: message });
}

function parse<T extends z.ZodType>(schema: T, body: unknown, reply: FastifyReply): z.infer<T> | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    void bad(reply, result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    return null;
  }
  return result.data;
}

const uid = (request: FastifyRequest) => request.user!.id;

// ---------------- schemas ----------------

const credentials = z.object({
  email: z.string().trim().toLowerCase().email('邮箱格式不正确'),
  password: z.string().min(6, '密码至少 6 位').max(128),
});
const registerSchema = credentials.extend({ name: z.string().trim().min(1, '请填写昵称').max(40) });

const paramsSchema = z.object({
  aspectRatio: z.string().max(10),
  resolution: z.string().max(10),
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
  count: z.number().int().min(1).max(4),
  seed: z.number().int().nullable(),
  steps: z.number().int().min(1).max(150).optional(),
  cfg: z.number().min(0).max(30).optional(),
  strength: z.number().min(0).max(1).optional(),
  duration: z.number().min(1).max(30).optional(),
  fps: z.number().int().min(8).max(60).optional(),
  cameraMotion: z.string().max(60).optional(),
  model: z.string().max(60).optional(),
});

const taskSchema = z.object({
  type: z.enum(['t2i', 'i2i', 't2v', 'i2v']),
  title: z.string().max(120).optional(),
  prompt: z.string().trim().min(1, '请输入提示词').max(4000),
  negativePrompt: z.string().max(2000).default(''),
  params: paramsSchema,
  inputs: z
    .object({
      referenceAssetIds: z.array(z.string()).max(4).optional(),
      firstFrameAssetId: z.string().nullable().optional(),
      lastFrameAssetId: z.string().nullable().optional(),
    })
    .default({}),
  link: z
    .object({
      storyId: z.string().nullable().optional(),
      shotId: z.string().nullable().optional(),
      purpose: z.enum(['keyframe', 'video']).nullable().optional(),
    })
    .default({}),
  priority: z.number().int().min(-10).max(10).default(0),
  runNow: z.boolean().default(false),
});

// ---------------- helpers ----------------

function ownsAsset(userId: string, assetId: string | null | undefined): boolean {
  if (!assetId) return true;
  const row = getAssetRow(assetId);
  return Boolean(row && row.user_id === userId);
}

function insertTask(userId: string, input: z.infer<typeof taskSchema>): Task {
  const id = newId('t_');
  const ts = now();
  db.prepare(
    `INSERT INTO tasks (id, user_id, type, status, title, prompt, negative_prompt, params, inputs, story_id, shot_id, purpose,
       max_attempts, priority, next_attempt_at, manual_kick, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    input.type,
    input.title?.trim() || input.prompt.slice(0, 40),
    input.prompt,
    input.negativePrompt,
    JSON.stringify(input.params),
    JSON.stringify(input.inputs),
    input.link.storyId ?? null,
    input.link.shotId ?? null,
    input.link.purpose ?? null,
    config.maxAttempts,
    input.priority,
    0,
    input.runNow ? 1 : 0,
    ts,
    ts,
  );
  return getTask(id)!;
}

/**
 * 按算子能力规整参数：去掉不起作用的参数，尺寸、时长、张数收进支持范围。
 * 前端已经按能力隐藏了控件，这里兜底旧客户端和故事批量生成。
 */
function normalizeTask(input: z.infer<typeof taskSchema>): z.infer<typeof taskSchema> {
  const caps = capabilities();
  const video = input.type === 't2v' || input.type === 'i2v';
  const cap = video ? caps.video : caps.image;
  const params = { ...input.params };
  if (!cap.strength) delete params.strength;
  if (!cap.cfg) delete params.cfg;
  if (!cap.steps) delete params.steps;
  params.count = Math.min(Math.max(params.count, 1), cap.maxCount);
  if (cap.sizes.length) Object.assign(params, resolveSize(cap, params.aspectRatio, params.resolution));
  if (video && params.duration != null) params.duration = clampDuration(cap, params.duration);
  const inputs = { ...input.inputs };
  if (inputs.referenceAssetIds) inputs.referenceAssetIds = inputs.referenceAssetIds.slice(0, Math.max(caps.image.maxReferences, 0));
  if (!caps.video.lastFrame) inputs.lastFrameAssetId = null;
  return {
    ...input,
    negativePrompt: cap.negativePrompt ? input.negativePrompt : '',
    params,
    inputs,
  };
}

function validateTaskInput(userId: string, input: z.infer<typeof taskSchema>): string | null {
  const refs = [...(input.inputs.referenceAssetIds ?? []), input.inputs.firstFrameAssetId, input.inputs.lastFrameAssetId];
  if (!refs.every((id) => ownsAsset(userId, id))) return '参考素材不存在';
  if (input.type === 'i2i' && !input.inputs.referenceAssetIds?.length) return '图生图需要至少一张参考图';
  if (input.type === 'i2v' && !input.inputs.firstFrameAssetId) return '图生视频需要首帧图片';
  if (input.link.storyId) {
    const story = db.prepare('SELECT user_id FROM stories WHERE id = ?').get(input.link.storyId) as Row | undefined;
    if (!story || story.user_id !== userId) return '故事不存在';
  }
  return null;
}

/** 每个故事最多保留的历史版本数 */
const MAX_SNAPSHOTS = 50;

function snapshotStory(row: Row, reason: string): void {
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

function ownedStory(request: FastifyRequest, id: string): Row | undefined {
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

function storySummary(row: Row): StorySummary {
  const data = parseJson<StoryData>(row.data, emptyStory());
  const shotCount = data.chapters.reduce(
    (sum, chapter) => sum + chapter.scenes.reduce((s, scene) => s + scene.shots.length, 0),
    0,
  );
  const cover = db
    .prepare("SELECT id FROM assets WHERE story_id = ? AND kind = 'image' ORDER BY created_at DESC LIMIT 1")
    .get(String(row.id)) as Row | undefined;
  return {
    id: String(row.id),
    title: String(row.title),
    rev: Number(row.rev ?? 0),
    logline: data.logline,
    coverUrl: cover ? assetUrl(String(cover.id)) : null,
    shotCount,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function ownedTask(request: FastifyRequest, reply: FastifyReply): Task | null {
  const { id } = request.params as { id: string };
  if (getTaskOwner(id) !== uid(request)) {
    void bad(reply, '任务不存在', 404);
    return null;
  }
  return getTask(id);
}

function setTask(id: string, fields: Record<string, unknown>): Task {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE tasks SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((key) => fields[key] as never),
    now(),
    id,
  );
  return getTask(id)!;
}

// ---------------- routes ----------------

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ---- auth ----
  app.post('/api/auth/register', async (request, reply) => {
    const body = parse(registerSchema, request.body, reply);
    if (!body) return;
    if (findUserByEmail(body.email)) return bad(reply, '该邮箱已注册', 409);
    const user = createUser(body.email, body.name, await hashPassword(body.password));
    startSession(reply, user.id);
    return { user, settings: getUserSettings(user.id) };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = parse(credentials, request.body, reply);
    if (!body) return;
    const row = findUserByEmail(body.email);
    if (!row || !(await verifyPassword(body.password, row.password_hash))) {
      return bad(reply, '邮箱或密码错误', 401);
    }
    startSession(reply, String(row.id));
    return { user: toUser(row), settings: getUserSettings(String(row.id)) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    endSession(request, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    if (!request.user) return { user: null, settings: null };
    return { user: request.user, settings: getUserSettings(request.user.id) };
  });

  // 未登录只返回各能力是否可用，不暴露算子的报错细节
  app.get('/api/health', async (request) => {
    const health = await getHealth();
    if (request.user) return health;
    return { provider: health.provider, image: health.image, video: health.video, llm: health.llm, checkedAt: health.checkedAt };
  });

  // ---- 以下接口需要登录 ----
  app.register(async (api) => {
    api.addHook('preHandler', requireUser);

    api.patch('/api/settings', async (request, reply) => {
      const body = parse(
        z.object({
          autoDispatch: z.boolean().optional(),
          pollIntervalSec: z.number().int().min(5).max(3600).optional(),
        }),
        request.body,
        reply,
      );
      if (!body) return;
      if (body.autoDispatch !== undefined) {
        db.prepare('UPDATE users SET auto_dispatch = ? WHERE id = ?').run(body.autoDispatch ? 1 : 0, uid(request));
      }
      if (body.pollIntervalSec !== undefined) {
        db.prepare('UPDATE users SET poll_interval_sec = ? WHERE id = ?').run(body.pollIntervalSec, uid(request));
      }
      if (body.autoDispatch) kickScheduler();
      return getUserSettings(uid(request));
    });

    api.post('/api/health/refresh', async () => getHealth(true));

    api.get('/api/capabilities', async () => capabilities());

    // SSE：推送任务、资产与服务状态变化
    api.get('/api/events', (request, reply) => {
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (event: ServerEvent) => raw.write(`data: ${JSON.stringify(event)}\n\n`);
      raw.write('retry: 3000\n\n');
      void getHealth().then((health) => send({ type: 'health', health }));
      const unsubscribe = subscribe(uid(request), send);
      const heartbeat = setInterval(() => raw.write(': ping\n\n'), 25_000);
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    });

    // ---- tasks ----
    api.get('/api/tasks', async (request) => {
      const query = request.query as { status?: string; storyId?: string; limit?: string };
      const where = ['user_id = ?'];
      const args: (string | number)[] = [uid(request)];
      if (query.status) {
        const statuses = query.status.split(',').filter(Boolean);
        where.push(`status IN (${statuses.map(() => '?').join(',')})`);
        args.push(...statuses);
      }
      if (query.storyId) {
        where.push('story_id = ?');
        args.push(query.storyId);
      }
      const limit = Math.min(Number(query.limit) || 300, 1000);
      const rows = db
        .prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`)
        .all(...args) as Row[];
      return rows.map(toTask);
    });

    api.post('/api/tasks', async (request, reply) => {
      const body = parse(taskSchema, request.body, reply);
      if (!body) return;
      const error = validateTaskInput(uid(request), body);
      if (error) return bad(reply, error);
      const task = insertTask(uid(request), normalizeTask(body));
      kickScheduler();
      return task;
    });

    api.post('/api/tasks/batch', async (request, reply) => {
      const body = parse(z.object({ tasks: z.array(taskSchema).min(1).max(200) }), request.body, reply);
      if (!body) return;
      for (const item of body.tasks) {
        const error = validateTaskInput(uid(request), item);
        if (error) return bad(reply, error);
      }
      const tasks = body.tasks.map((item) => insertTask(uid(request), normalizeTask(item)));
      kickScheduler();
      return tasks;
    });

    // 立即运行：无论是否开启自动调度，马上尝试提交一次
    api.post('/api/tasks/:id/run', async (request, reply) => {
      const task = ownedTask(request, reply);
      if (!task) return;
      if (task.status === 'running' || task.status === 'succeeded') return task;
      const updated = setTask(task.id, {
        status: 'queued',
        manual_kick: 1,
        next_attempt_at: 0,
        wait_reason: null,
        ...(task.status === 'failed' || task.status === 'canceled' ? { attempts: 0, last_error: null, finished_at: null } : {}),
      });
      kickScheduler();
      return updated;
    });

    api.post('/api/tasks/:id/pause', async (request, reply) => {
      const task = ownedTask(request, reply);
      if (!task) return;
      if (task.status !== 'queued') return bad(reply, '只有排队中的任务可以暂停');
      return setTask(task.id, { status: 'paused', manual_kick: 0 });
    });

    api.post('/api/tasks/:id/resume', async (request, reply) => {
      const task = ownedTask(request, reply);
      if (!task) return;
      if (task.status !== 'paused') return bad(reply, '任务未暂停');
      const updated = setTask(task.id, { status: 'queued', next_attempt_at: 0 });
      kickScheduler();
      return updated;
    });

    api.post('/api/tasks/:id/cancel', async (request, reply) => {
      const task = ownedTask(request, reply);
      if (!task) return;
      if (!['queued', 'paused', 'running'].includes(task.status)) return task;
      const row = db.prepare('SELECT provider_job_id FROM tasks WHERE id = ?').get(task.id) as Row;
      if (task.status === 'running' && row.provider_job_id) {
        await provider.cancel(String(row.provider_job_id)).catch(() => undefined);
      }
      return setTask(task.id, { status: 'canceled', manual_kick: 0, provider_job_id: null, finished_at: now() });
    });

    api.post('/api/tasks/:id/retry', async (request, reply) => {
      const task = ownedTask(request, reply);
      if (!task) return;
      if (!['failed', 'canceled', 'succeeded'].includes(task.status)) return task;
      // 已完成的任务“再来一次”：复制一个新任务，保留原结果
      if (task.status === 'succeeded') {
        const copy = insertTask(uid(request), {
          type: task.type,
          title: task.title,
          prompt: task.prompt,
          negativePrompt: task.negativePrompt,
          params: { ...task.params, seed: null },
          inputs: task.inputs,
          link: task.link,
          priority: task.priority,
          runNow: true,
        });
        kickScheduler();
        return copy;
      }
      const updated = setTask(task.id, {
        status: 'queued',
        attempts: 0,
        last_error: null,
        wait_reason: null,
        finished_at: null,
        next_attempt_at: 0,
        manual_kick: 1,
      });
      kickScheduler();
      return updated;
    });

    api.patch('/api/tasks/:id', async (request, reply) => {
      const task = ownedTask(request, reply);
      if (!task) return;
      const body = parse(z.object({ priority: z.number().int().min(-10).max(10) }), request.body, reply);
      if (!body) return;
      return setTask(task.id, { priority: body.priority });
    });

    api.delete('/api/tasks/:id', async (request, reply) => {
      const task = ownedTask(request, reply);
      if (!task) return;
      if (task.status === 'running') return bad(reply, '生成中的任务请先取消');
      db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
      return { ok: true };
    });

    api.post('/api/queue/run-all', async (request) => {
      const result = db
        .prepare(
          "UPDATE tasks SET manual_kick = 1, next_attempt_at = 0, wait_reason = NULL, updated_at = ? WHERE user_id = ? AND status = 'queued'",
        )
        .run(now(), uid(request));
      kickScheduler();
      return { count: Number(result.changes) };
    });

    api.post('/api/queue/pause-all', async (request) => {
      const result = db
        .prepare("UPDATE tasks SET status = 'paused', manual_kick = 0, updated_at = ? WHERE user_id = ? AND status = 'queued'")
        .run(now(), uid(request));
      return { count: Number(result.changes) };
    });

    api.post('/api/queue/resume-all', async (request) => {
      const result = db
        .prepare("UPDATE tasks SET status = 'queued', next_attempt_at = 0, updated_at = ? WHERE user_id = ? AND status = 'paused'")
        .run(now(), uid(request));
      kickScheduler();
      return { count: Number(result.changes) };
    });

    api.post('/api/queue/clear-finished', async (request) => {
      const result = db
        .prepare("DELETE FROM tasks WHERE user_id = ? AND status IN ('succeeded', 'canceled')")
        .run(uid(request));
      return { count: Number(result.changes) };
    });

    // ---- assets ----
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

    // ---- stories ----
    api.get('/api/stories', async (request) => {
      const rows = db.prepare('SELECT * FROM stories WHERE user_id = ? ORDER BY updated_at DESC').all(uid(request)) as Row[];
      return rows.map(storySummary);
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

    // ---- assist ----
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
  });
}
