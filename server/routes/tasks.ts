// 生成任务与队列
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clampDuration, resolveSize } from '../../shared/operator.ts';
import type { Task } from '../../shared/types.ts';
import { config } from '../config.ts';
import { db, newId, now, type Row } from '../db.ts';
import { capabilities, getAdapter } from '../providers/index.ts';
import { getTask, getTaskOwner, toTask } from '../repo.ts';
import { kickScheduler } from '../scheduler.ts';
import { bad, ownsAsset, parse, uid } from './common.ts';

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
function normalizeTask(input: z.infer<typeof taskSchema>, isAdmin = false): z.infer<typeof taskSchema> {
  const caps = capabilities(isAdmin);
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

export async function taskRoutes(api: FastifyInstance): Promise<void> {
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
    const task = insertTask(uid(request), normalizeTask(body, request.user!.isAdmin));
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
    const tasks = body.tasks.map((item) => insertTask(uid(request), normalizeTask(item, request.user!.isAdmin)));
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
    const row = db.prepare('SELECT provider_job_id, operator_id FROM tasks WHERE id = ?').get(task.id) as Row;
    if (task.status === 'running' && row.provider_job_id) {
      await getAdapter((row.operator_id as string | null) ?? null)
        ?.cancel(String(row.provider_job_id))
        .catch(() => undefined);
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
}
