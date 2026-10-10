// 任务调度器：
// 1. 轮询生成中的任务进度，完成后把结果落地为资产
// 2. 把排队任务提交给生成服务 —— 用户开启“自动调度”时按间隔自动尝试；
//    关闭时只有手动点“立即运行”的任务才会被提交
// 3. 生成服务不可用时任务保持排队并记录等待原因，不计入失败次数；
//    真正的生成失败按指数退避重试，超过次数才标记失败
import { randomInt } from 'node:crypto';
import fs from 'node:fs/promises';
import { capabilityOf, type Task } from '../shared/types.ts';
import { publish } from './bus.ts';
import { config } from './config.ts';
import { db, now, type Row } from './db.ts';
import { absoluteFile, deleteAssetFile, saveAsset } from './files.ts';
import { getHealth, markUnavailable, provider, ProviderUnavailableError, type ProviderImageInput, type ProviderOutput } from './providers/index.ts';
import { logger } from './log.ts';
import { getAssetRow, getTask, toAsset, toTask } from './repo.ts';

function emitTask(id: string): void {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
  if (row) publish(String(row.user_id), { type: 'task', task: toTask(row) });
}

/**
 * 更新任务。传了 onlyIf 时只在任务仍处于这些状态时才更新（比较并交换），
 * 防止调度器覆盖用户在此期间做的取消、暂停或删除。返回是否真的更新了。
 */
function update(id: string, fields: Record<string, unknown>, onlyIf?: Task['status'][]): boolean {
  const keys = Object.keys(fields);
  const sets = keys.map((key) => `${key} = ?`).join(', ');
  const guard = onlyIf ? ` AND status IN (${onlyIf.map(() => '?').join(',')})` : '';
  const result = db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?${guard}`).run(
    ...keys.map((key) => fields[key] as never),
    now(),
    id,
    ...(onlyIf ?? []),
  );
  return Number(result.changes) > 0;
}

/** 用户没指定种子时由服务端生成，这样每张图实际用的种子都有记录、可以复现 */
function randomSeed(): number {
  return randomInt(1, 2 ** 31 - 16);
}

function userOf(taskId: string): string {
  return String((db.prepare('SELECT user_id FROM tasks WHERE id = ?').get(taskId) as Row).user_id);
}

function pollIntervalMs(userId: string): number {
  const row = db.prepare('SELECT poll_interval_sec FROM users WHERE id = ?').get(userId) as Row;
  return Math.max(5, Number(row.poll_interval_sec)) * 1000;
}

function setWaiting(task: Task, reason: string): void {
  // 保留 manual_kick：用户点过“立即运行”的任务，服务恢复后仍要优先提交
  const changed = update(
    task.id,
    {
      status: 'queued',
      wait_reason: reason,
      next_attempt_at: now() + pollIntervalMs(userOf(task.id)),
      provider_job_id: null,
      progress: 0,
      stage: null,
    },
    ['queued', 'running'],
  );
  if (changed) emitTask(task.id);
}

function fail(task: Task, message: string): void {
  const fresh = getTask(task.id);
  // 任务已被取消、暂停或删除：不再改动
  if (!fresh || (fresh.status !== 'running' && fresh.status !== 'queued')) return;
  if (fresh.attempts < fresh.maxAttempts) {
    const backoff = 15_000 * 2 ** Math.max(0, fresh.attempts - 1);
    update(task.id, {
      status: 'queued',
      last_error: `${message}（第 ${fresh.attempts} 次失败，${Math.round(backoff / 1000)} 秒后重试）`,
      wait_reason: null,
      next_attempt_at: now() + backoff,
      provider_job_id: null,
      progress: 0,
      stage: null,
    }, ['running', 'queued']);
  } else {
    update(task.id, {
      status: 'failed',
      last_error: message,
      wait_reason: null,
      stage: null,
      provider_job_id: null,
      finished_at: now(),
    }, ['running', 'queued']);
  }
  emitTask(task.id);
}

function resolveImages(task: Task): ProviderImageInput[] {
  const images: ProviderImageInput[] = [];
  const push = (assetId: string | null | undefined, role: ProviderImageInput['role']) => {
    if (!assetId) return;
    const row = getAssetRow(assetId);
    if (!row) throw new Error(`参考素材 ${assetId} 不存在`);
    images.push({ role, mime: String(row.mime), path: absoluteFile(String(row.file)) });
  };
  for (const id of task.inputs.referenceAssetIds ?? []) push(id, 'reference');
  push(task.inputs.firstFrameAssetId, 'first_frame');
  push(task.inputs.lastFrameAssetId, 'last_frame');
  return images;
}

async function outputData(output: ProviderOutput): Promise<{ data?: Buffer; filePath?: string }> {
  if (output.filePath) return { filePath: output.filePath };
  if (output.base64) return { data: Buffer.from(output.base64, 'base64') };
  if (output.url) {
    const response = await fetch(output.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`下载生成结果失败（HTTP ${response.status}）`);
    return { data: Buffer.from(await response.arrayBuffer()) };
  }
  throw new Error('生成服务没有返回结果文件');
}

async function discardOutputs(outputs: ProviderOutput[]): Promise<void> {
  await Promise.all(outputs.map((output) => (output.filePath ? fs.rm(output.filePath, { force: true }) : undefined)));
}

async function complete(task: Task, outputs: ProviderOutput[], runSeed: number | null): Promise<void> {
  // 下载期间用户可能已经取消了任务：不再保存
  if (getTask(task.id)?.status !== 'running') {
    await discardOutputs(outputs);
    return;
  }
  const userId = userOf(task.id);
  const saved: { id: string; file: string }[] = [];
  try {
    for (const [index, output] of outputs.entries()) {
      // 多张图按顺序对应种子 base、base+1……（和提交时的拆分一致）
      const seed = output.seed ?? (runSeed == null ? null : output.kind === 'image' ? runSeed + index : runSeed);
      const asset = await saveAsset({
        userId,
        kind: output.kind,
        source: 'generated',
        mime: output.mime,
        ...(await outputData(output)),
        width: output.width ?? task.params.width,
        height: output.height ?? task.params.height,
        prompt: task.prompt,
        taskId: task.id,
        storyId: task.link.storyId,
        shotId: task.link.shotId,
        purpose: task.link.purpose,
        gen: {
          type: task.type,
          seed,
          width: task.params.width,
          height: task.params.height,
          duration: task.params.duration ?? null,
          steps: task.params.steps ?? null,
          negativePrompt: task.negativePrompt,
          operator: provider.name,
        },
      });
      saved.push({ id: asset.id, file: String((db.prepare('SELECT file FROM assets WHERE id = ?').get(asset.id) as Row).file) });
    }
  } catch (error) {
    await discardOutputs(outputs);
    throw error;
  }
  const changed = update(
    task.id,
    {
      status: 'succeeded',
      progress: 1,
      output_asset_ids: JSON.stringify(saved.map((item) => item.id)),
      wait_reason: null,
      stage: null,
      last_error: null,
      finished_at: now(),
    },
    ['running'],
  );
  if (!changed) {
    // 保存期间被取消：撤销刚保存的资产
    for (const item of saved) {
      db.prepare('DELETE FROM assets WHERE id = ?').run(item.id);
      await deleteAssetFile(item.file);
    }
    return;
  }
  for (const item of saved) {
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(item.id) as Row;
    publish(userId, { type: 'asset', asset: toAsset(row) });
  }
  emitTask(task.id);
}

/** 每个任务上次查询进度的时间，按适配器建议的间隔查询（图片几秒一次，视频十几秒一次） */
const lastPolledAt = new Map<string, number>();
/** 正在查询或下载产物的任务：下载可能要几分钟，不能卡住调度节拍 */
const inflight = new Set<string>();

async function pollTask(task: Task, jobId: string, runSeed: number | null): Promise<void> {
  try {
    const status = await provider.poll(jobId);
    if (status.state === 'succeeded') {
      await complete(task, status.outputs ?? [], runSeed);
    } else if (status.state === 'failed') {
      fail(task, status.error ?? '生成失败');
    } else {
      const fresh = getTask(task.id) ?? task;
      const progress = status.progress ?? fresh.progress;
      const stage = status.stage ?? fresh.stage;
      if (Math.abs(progress - fresh.progress) >= 0.02 || fresh.waitReason || stage !== fresh.stage) {
        if (update(task.id, { progress, stage, wait_reason: null }, ['running'])) emitTask(task.id);
      }
    }
  } catch (error) {
    if (error instanceof ProviderUnavailableError) {
      // 查询进度时服务失联：保持运行状态，下次再查
      const fresh = getTask(task.id);
      if (fresh && fresh.waitReason !== error.message && update(task.id, { wait_reason: error.message }, ['running'])) {
        emitTask(task.id);
      }
    } else {
      fail(task, (error as Error).message);
    }
  }
}

function pollRunning(): void {
  const rows = db.prepare("SELECT * FROM tasks WHERE status = 'running'").all() as Row[];
  const runningIds = new Set(rows.map((row) => String(row.id)));
  for (const id of lastPolledAt.keys()) if (!runningIds.has(id)) lastPolledAt.delete(id);
  for (const row of rows) {
    const task = toTask(row);
    if (inflight.has(task.id)) continue;
    const jobId = row.provider_job_id as string | null;
    if (!jobId) {
      fail(task, '缺少生成服务任务号');
      continue;
    }
    const timeoutMs = capabilityOf(task.type) === 'video' ? config.videoJobTimeoutMs : config.jobTimeoutMs;
    if (task.startedAt && now() - task.startedAt > timeoutMs) {
      void provider.cancel(jobId).catch(() => undefined);
      fail(task, `生成超时（超过 ${Math.round(timeoutMs / 60_000)} 分钟）`);
      continue;
    }
    const interval = provider.pollIntervalMs?.(jobId) ?? 0;
    if (now() - (lastPolledAt.get(task.id) ?? 0) < interval) continue;
    lastPolledAt.set(task.id, now());
    inflight.add(task.id);
    const runSeed = row.run_seed == null ? null : Number(row.run_seed);
    void pollTask(task, jobId, runSeed)
      .catch((error) => logger.error({ err: error, taskId: task.id }, '查询任务进度失败'))
      .finally(() => inflight.delete(task.id));
  }
}

async function dispatch(): Promise<void> {
  const running = Number((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'").get() as Row).n);
  let slots = config.maxRunning - running;
  if (slots <= 0) return;

  const candidates = db
    .prepare(
      `SELECT t.* FROM tasks t JOIN users u ON u.id = t.user_id
       WHERE t.status = 'queued' AND t.next_attempt_at <= ? AND (u.auto_dispatch = 1 OR t.manual_kick = 1)
       ORDER BY t.manual_kick DESC, t.priority DESC, t.created_at ASC LIMIT 50`,
    )
    .all(now()) as Row[];
  if (candidates.length === 0) return;

  const health = await getHealth();
  for (const row of candidates) {
    if (slots <= 0) break;
    const task = toTask(row);
    const capability = capabilityOf(task.type);
    if (!health[capability]) {
      setWaiting(task, health.message ? `生成服务不可用：${health.message}` : '生成服务暂不可用，等待重试');
      continue;
    }
    let images: ProviderImageInput[];
    try {
      images = resolveImages(task);
    } catch (error) {
      update(task.id, { status: 'failed', last_error: (error as Error).message, finished_at: now() });
      emitTask(task.id);
      continue;
    }
    const seed = task.params.seed ?? randomSeed();
    try {
      const { jobId } = await provider.submit({
        taskId: task.id,
        type: task.type,
        prompt: task.prompt,
        negativePrompt: task.negativePrompt,
        params: { ...task.params, seed },
        images,
      });
      // 提交期间用户可能取消、暂停或删除了任务：只有仍在排队时才改成运行中
      const changed = update(
        task.id,
        {
          status: 'running',
          provider_job_id: jobId,
          run_seed: seed,
          attempts: task.attempts + 1,
          manual_kick: 0,
          progress: 0,
          stage: null,
          wait_reason: null,
          started_at: now(),
        },
        ['queued'],
      );
      if (!changed) {
        await provider.cancel(jobId).catch(() => undefined);
        continue;
      }
      emitTask(task.id);
      slots--;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        markUnavailable(capability, error.message);
        setWaiting(task, error.message);
      } else {
        update(task.id, { attempts: task.attempts + 1, manual_kick: 0 }, ['queued']);
        fail(task, (error as Error).message);
      }
    }
  }
}

let ticking = false;
let pendingKick = false;

async function tick(): Promise<void> {
  if (ticking) {
    pendingKick = true;
    return;
  }
  ticking = true;
  try {
    pollRunning();
    await dispatch();
  } catch (error) {
    logger.error({ err: error }, '调度节拍失败');
  } finally {
    ticking = false;
    if (pendingKick) {
      pendingKick = false;
      setImmediate(() => void tick());
    }
  }
}

/** 手动触发后立即跑一个节拍，不用等定时器 */
export function kickScheduler(): void {
  setImmediate(() => void tick());
}

let lastHealthKey = '';
async function broadcastHealth(): Promise<void> {
  try {
    const health = await getHealth();
    const key = `${health.image}${health.video}${health.llm}${health.message}`;
    if (key !== lastHealthKey) {
      lastHealthKey = key;
      publish('*', { type: 'health', health });
    }
  } catch {
    // 健康检查本身失败不影响调度
  }
}

export function startScheduler(): () => void {
  const timer = setInterval(() => void tick(), config.schedulerTickMs);
  const healthTimer = setInterval(() => void broadcastHealth(), config.healthTtlMs);
  void tick();
  void broadcastHealth();
  return () => {
    clearInterval(timer);
    clearInterval(healthTimer);
  };
}
