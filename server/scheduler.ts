// 任务调度器：
// 1. 轮询生成中的任务进度，完成后把结果落地为资产
// 2. 把排队任务提交给生成服务 —— 用户开启“自动调度”时按间隔自动尝试；
//    关闭时只有手动点“立即运行”的任务才会被提交
// 3. 生成服务不可用时任务保持排队并记录等待原因，不计入失败次数；
//    真正的生成失败按指数退避重试，超过次数才标记失败
import { capabilityOf, type Task } from '../shared/types.ts';
import { publish } from './bus.ts';
import { config } from './config.ts';
import { db, now, type Row } from './db.ts';
import { absoluteFile, saveAsset } from './files.ts';
import { getHealth, markUnavailable, provider, ProviderUnavailableError, type ProviderImageInput, type ProviderOutput } from './providers/index.ts';
import { getAssetRow, getTask, toTask } from './repo.ts';

function emitTask(id: string): void {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
  if (row) publish(String(row.user_id), { type: 'task', task: toTask(row) });
}

function update(id: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  const sets = keys.map((key) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((key) => fields[key] as never),
    now(),
    id,
  );
}

function userOf(taskId: string): string {
  return String((db.prepare('SELECT user_id FROM tasks WHERE id = ?').get(taskId) as Row).user_id);
}

function pollIntervalMs(userId: string): number {
  const row = db.prepare('SELECT poll_interval_sec FROM users WHERE id = ?').get(userId) as Row;
  return Math.max(5, Number(row.poll_interval_sec)) * 1000;
}

function setWaiting(task: Task, reason: string): void {
  update(task.id, {
    status: 'queued',
    wait_reason: reason,
    manual_kick: 0,
    next_attempt_at: now() + pollIntervalMs(userOf(task.id)),
    provider_job_id: null,
    progress: 0,
  });
  emitTask(task.id);
}

function fail(task: Task, message: string): void {
  const fresh = getTask(task.id) ?? task;
  if (fresh.attempts < fresh.maxAttempts) {
    const backoff = 15_000 * 2 ** Math.max(0, fresh.attempts - 1);
    update(task.id, {
      status: 'queued',
      last_error: `${message}（第 ${fresh.attempts} 次失败，${Math.round(backoff / 1000)} 秒后重试）`,
      wait_reason: null,
      next_attempt_at: now() + backoff,
      provider_job_id: null,
      progress: 0,
    });
  } else {
    update(task.id, {
      status: 'failed',
      last_error: message,
      wait_reason: null,
      provider_job_id: null,
      finished_at: now(),
    });
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

async function outputToBuffer(output: ProviderOutput): Promise<Buffer> {
  if (output.base64) return Buffer.from(output.base64, 'base64');
  if (output.url) {
    const response = await fetch(output.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`下载生成结果失败（HTTP ${response.status}）`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error('生成服务没有返回结果文件');
}

async function complete(task: Task, outputs: ProviderOutput[]): Promise<void> {
  const userId = userOf(task.id);
  const assetIds: string[] = [];
  for (const output of outputs) {
    const asset = await saveAsset({
      userId,
      kind: output.kind,
      source: 'generated',
      mime: output.mime,
      data: await outputToBuffer(output),
      width: output.width ?? task.params.width,
      height: output.height ?? task.params.height,
      prompt: task.prompt,
      taskId: task.id,
      storyId: task.link.storyId,
      shotId: task.link.shotId,
      purpose: task.link.purpose,
    });
    assetIds.push(asset.id);
    publish(userId, { type: 'asset', asset });
  }
  update(task.id, {
    status: 'succeeded',
    progress: 1,
    output_asset_ids: JSON.stringify(assetIds),
    wait_reason: null,
    last_error: null,
    finished_at: now(),
  });
  emitTask(task.id);
}

async function pollRunning(): Promise<void> {
  const rows = db.prepare("SELECT * FROM tasks WHERE status = 'running'").all() as Row[];
  for (const row of rows) {
    const task = toTask(row);
    const jobId = row.provider_job_id as string | null;
    if (!jobId) {
      fail(task, '缺少生成服务任务号');
      continue;
    }
    if (task.startedAt && now() - task.startedAt > config.jobTimeoutMs) {
      await provider.cancel(jobId).catch(() => undefined);
      fail(task, '生成超时');
      continue;
    }
    try {
      const status = await provider.poll(jobId);
      if (status.state === 'succeeded') {
        await complete(task, status.outputs ?? []);
      } else if (status.state === 'failed') {
        fail(task, status.error ?? '生成失败');
      } else {
        const progress = status.progress ?? task.progress;
        if (Math.abs(progress - task.progress) >= 0.02 || task.waitReason) {
          update(task.id, { progress, wait_reason: null });
          emitTask(task.id);
        }
      }
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        // 查询进度时服务失联：保持运行状态，下个节拍再查
        if (task.waitReason !== error.message) {
          update(task.id, { wait_reason: error.message });
          emitTask(task.id);
        }
      } else {
        fail(task, (error as Error).message);
      }
    }
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
    try {
      const { jobId } = await provider.submit({
        taskId: task.id,
        type: task.type,
        prompt: task.prompt,
        negativePrompt: task.negativePrompt,
        params: task.params,
        images,
      });
      update(task.id, {
        status: 'running',
        provider_job_id: jobId,
        attempts: task.attempts + 1,
        manual_kick: 0,
        progress: 0,
        wait_reason: null,
        started_at: now(),
      });
      emitTask(task.id);
      slots--;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        markUnavailable(capability, error.message);
        setWaiting(task, error.message);
      } else {
        update(task.id, { attempts: task.attempts + 1, manual_kick: 0 });
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
    await pollRunning();
    await dispatch();
  } catch (error) {
    console.error('[scheduler] tick failed', error);
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
