// 服务状态、能力声明、用户设置、实时事件
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerEvent } from '../../shared/types.ts';
import { subscribe } from '../bus.ts';
import { capabilities, getHealth } from '../providers/index.ts';
import { getUserSettings } from '../repo.ts';
import { kickScheduler } from '../scheduler.ts';
import { db } from '../db.ts';
import { parse, uid } from './common.ts';

/** 不需要登录的状态接口 */
export async function publicSystemRoutes(app: FastifyInstance): Promise<void> {
  // 未登录只返回各能力是否可用，不暴露算子的报错细节
  app.get('/api/health', async (request) => {
    const isAdmin = Boolean(request.user?.isAdmin);
    const health = await getHealth(false, isAdmin, isAdmin);
    if (request.user) return health;
    return { provider: health.provider, image: health.image, video: health.video, llm: health.llm, checkedAt: health.checkedAt };
  });
}

export async function systemRoutes(api: FastifyInstance): Promise<void> {
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

  api.post('/api/health/refresh', async (request) => getHealth(true, request.user!.isAdmin, request.user!.isAdmin));

  api.get('/api/capabilities', async (request) => capabilities(request.user!.isAdmin));

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
    void getHealth(false, request.user!.isAdmin, request.user!.isAdmin).then((health) => send({ type: 'health', health }));
    const unsubscribe = subscribe(uid(request), send);
    const heartbeat = setInterval(() => raw.write(': ping\n\n'), 25_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
