// 后台作业：缩略图回填、故事迁移、回收站清理、成片渲染、工作流本地步骤……
// 存在 jobs 表里，服务重启后继续跑。两个通道：fast（轻量，并发 2）和 heavy（转码、拼接，并发 1），
// 重活不会堵住缩略图这类小活。
import type { Job } from '../../shared/types.ts';
import { publish } from '../bus.ts';
import { db, newId, now, parseJson, type Row } from '../db.ts';
import { logger } from '../log.ts';

export type JobLane = 'fast' | 'heavy';

export interface JobContext<P = Record<string, unknown>> {
  id: string;
  userId: string | null;
  payload: P;
  signal: AbortSignal;
  attempt: number;
  /** 汇报进度（0–1）和阶段文字，会推送给作业所属的用户 */
  progress(value: number, stage?: string): void;
}

interface JobKind {
  lane: JobLane;
  maxAttempts: number;
  handler: (ctx: JobContext<never>) => Promise<unknown>;
}

const kinds = new Map<string, JobKind>();
const LANE_LIMIT: Record<JobLane, number> = { fast: 2, heavy: 1 };
const running = new Map<string, { controller: AbortController; lane: JobLane }>();

export function registerJobKind<P>(kind: string, options: { lane?: JobLane; maxAttempts?: number; handler: (ctx: JobContext<P>) => Promise<unknown> }): void {
  kinds.set(kind, { lane: options.lane ?? 'fast', maxAttempts: options.maxAttempts ?? 2, handler: options.handler as JobKind['handler'] });
}

export function toJob(row: Row): Job {
  return {
    id: String(row.id),
    kind: String(row.kind),
    status: row.status as Job['status'],
    progress: Number(row.progress),
    stage: (row.stage as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    result: parseJson<Record<string, unknown> | null>(row.result, null),
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    createdAt: Number(row.created_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
  };
}

export function getJobRow(id: string): Row | null {
  return (db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined) ?? null;
}

function emit(id: string): void {
  const row = getJobRow(id);
  if (row?.user_id) publish(String(row.user_id), { type: 'job', job: toJob(row) });
}

export interface EnqueueOptions {
  userId?: string | null;
  /** 相同 key 的作业还在排队或运行时，不重复创建，直接返回已有的那个 */
  dedupeKey?: string;
  runAfter?: number;
}

export function enqueueJob(kind: string, payload: Record<string, unknown>, options: EnqueueOptions = {}): string {
  const spec = kinds.get(kind);
  if (!spec) throw new Error(`未注册的作业类型：${kind}`);
  if (options.dedupeKey) {
    const existing = db
      .prepare("SELECT id FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running') LIMIT 1")
      .get(options.dedupeKey) as Row | undefined;
    if (existing) return String(existing.id);
  }
  const id = newId('j_');
  const ts = now();
  db.prepare(
    `INSERT INTO jobs (id, user_id, kind, lane, status, payload, dedupe_key, run_after, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
  ).run(id, options.userId ?? null, kind, spec.lane, JSON.stringify(payload), options.dedupeKey ?? null, options.runAfter ?? 0, ts, ts);
  emit(id);
  kickJobs();
  return id;
}

/** 取消：排队中的直接标记；运行中的发出中止信号，由处理函数自行收尾 */
export function cancelJob(id: string): boolean {
  const result = db
    .prepare("UPDATE jobs SET status = 'canceled', finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')")
    .run(now(), now(), id);
  running.get(id)?.controller.abort();
  if (Number(result.changes) > 0) emit(id);
  return Number(result.changes) > 0;
}

/** 等待作业结束（测试和同步接口用） */
export async function waitJob(id: string, timeoutMs = 120_000): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = getJobRow(id);
    if (!row) throw new Error('作业不存在');
    if (!['queued', 'running'].includes(String(row.status))) return toJob(row);
    if (Date.now() > deadline) throw new Error('等待作业超时');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function execute(row: Row): Promise<void> {
  const id = String(row.id);
  const spec = kinds.get(String(row.kind));
  if (!spec) {
    db.prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ?").run('未知的作业类型', now(), now(), id);
    return;
  }
  const controller = new AbortController();
  running.set(id, { controller, lane: spec.lane });
  const attempt = Number(row.attempts) + 1;
  db.prepare("UPDATE jobs SET status = 'running', attempts = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?").run(attempt, now(), now(), id);
  emit(id);
  let lastEmit = 0;
  const ctx: JobContext<never> = {
    id,
    userId: (row.user_id as string | null) ?? null,
    payload: parseJson(row.payload, {}) as never,
    signal: controller.signal,
    attempt,
    progress(value, stage) {
      db.prepare("UPDATE jobs SET progress = ?, stage = COALESCE(?, stage), updated_at = ? WHERE id = ? AND status = 'running'").run(
        Math.max(0, Math.min(1, value)),
        stage ?? null,
        now(),
        id,
      );
      // 进度推送限流：每 300 ms 最多一次
      if (Date.now() - lastEmit > 300) {
        lastEmit = Date.now();
        emit(id);
      }
    },
  };
  try {
    const result = await spec.handler(ctx);
    db.prepare("UPDATE jobs SET status = 'succeeded', progress = 1, result = ?, error = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(
      result === undefined ? null : JSON.stringify(result),
      now(),
      now(),
      id,
    );
  } catch (error) {
    const message = (error as Error).message || String(error);
    if (controller.signal.aborted) {
      // 已被取消：cancelJob 已经改过状态
    } else if (attempt < spec.maxAttempts) {
      const backoff = 5000 * 2 ** (attempt - 1);
      db.prepare("UPDATE jobs SET status = 'queued', error = ?, run_after = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(message, now() + backoff, now(), id);
    } else {
      logger.warn({ jobId: id, kind: row.kind, err: message }, '后台作业失败');
      db.prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(message, now(), now(), id);
    }
  } finally {
    running.delete(id);
    emit(id);
    kickJobs();
  }
}

function pick(): void {
  for (const lane of ['fast', 'heavy'] as JobLane[]) {
    let busy = [...running.values()].filter((item) => item.lane === lane).length;
    if (busy >= LANE_LIMIT[lane]) continue;
    const rows = db
      .prepare("SELECT * FROM jobs WHERE status = 'queued' AND lane = ? AND run_after <= ? ORDER BY created_at LIMIT ?")
      .all(lane, now(), LANE_LIMIT[lane] - busy) as Row[];
    for (const row of rows) {
      if (running.has(String(row.id))) continue;
      busy++;
      void execute(row).catch((error) => logger.error({ err: error, jobId: row.id }, '作业执行异常'));
    }
  }
}

let kickPending = false;
export function kickJobs(): void {
  if (kickPending || !started) return;
  kickPending = true;
  setImmediate(() => {
    kickPending = false;
    pick();
  });
}

interface Recurring {
  kind: string;
  everyMs: number;
  payload: Record<string, unknown>;
}
const recurring: Recurring[] = [];

/** 周期作业（例如每 6 小时清理一次回收站）：到点入队，dedupe 防止堆积 */
export function everyInterval(kind: string, everyMs: number, payload: Record<string, unknown> = {}): void {
  recurring.push({ kind, everyMs, payload });
}

let started = false;

export function startJobs(): () => void {
  started = true;
  // 上次异常退出时正在跑的作业重新排队
  db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(now());
  // 30 天前结束的作业记录清掉
  db.prepare("DELETE FROM jobs WHERE status IN ('succeeded', 'failed', 'canceled') AND finished_at < ?").run(now() - 30 * 86_400_000);
  const timer = setInterval(pick, 1000);
  const timers = recurring.map((item) => {
    const fire = () => {
      try {
        enqueueJob(item.kind, item.payload, { dedupeKey: `recurring:${item.kind}` });
      } catch (error) {
        logger.error({ err: error, kind: item.kind }, '周期作业入队失败');
      }
    };
    // 启动 30 秒后先跑一次，之后按间隔
    const first = setTimeout(fire, 30_000);
    first.unref();
    const every = setInterval(fire, item.everyMs);
    every.unref();
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  });
  pick();
  return () => {
    started = false;
    clearInterval(timer);
    for (const stop of timers) stop();
    for (const item of running.values()) item.controller.abort();
  };
}
