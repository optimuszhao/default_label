// 生成任务与队列
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Task } from '../../shared/types.ts';
import { db, now, type Row } from '../db.ts';
import { getAdapter } from '../providers/index.ts';
import { getTask, getTaskOwner, toTask } from '../repo.ts';
import { emitTask, kickScheduler, notifyTaskSettled } from '../scheduler.ts';
import { createTasks, insertTask, taskSchema, type TaskInput } from '../tasks/create.ts';
import { bad, parse, uid } from './common.ts';

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
    const result = createTasks(request.user!, [body]);
    if (typeof result === 'string') return bad(reply, result);
    return result[0];
  });

  api.post('/api/tasks/batch', async (request, reply) => {
    const body = parse(z.object({ tasks: z.array(taskSchema).min(1).max(200) }), request.body, reply);
    if (!body) return;
    const result = createTasks(request.user!, body.tasks);
    if (typeof result === 'string') return bad(reply, result);
    return result;
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
    const canceled = setTask(task.id, { status: 'canceled', manual_kick: 0, provider_job_id: null, finished_at: now() });
    emitTask(task.id);
    notifyTaskSettled(canceled);
    return canceled;
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
        // 再来一次：保留配方，但种子换新（锁定的种子也解除）
        recipe: task.recipe ? { ...task.recipe, overrides: { ...task.recipe.overrides, seed: null } } : undefined,
      } as TaskInput);
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
    if (task.status === 'queued' || task.status === 'paused') notifyTaskSettled({ ...task, status: 'canceled' });
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
