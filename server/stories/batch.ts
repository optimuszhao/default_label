// 故事的服务端批量生成（STY-09）：
//   范围：全片 / 章 / 场 / 选中的镜头；内容：关键帧 / 视频 / 先关键帧再视频；
//   模式：只补缺 / 追加候选 / 重做未定稿的。提交前可以先试算（任务数、GPU 时长、预计完成时间）。
//   已定稿的镜头不会被批量操作改动；有进行中任务的镜头跳过。
//   "先关键帧再视频"：先只建关键帧任务，关键帧生成成功后由任务结束回调接着建视频任务。
//   "接续上一镜尾帧"：上一镜的视频也在这次批量里（或正在生成）时，这一镜先记一条接续等待（story_chains），
//   上一镜视频成功后截尾帧再建这一镜的视频任务，一镜接一镜串下去；接续的镜头在"先关键帧再视频"里不出关键帧。
import type { Shot, StoryData, Task } from '../../shared/types.ts';
import { buildShotPrompt, buildShotTask, estimateSeconds, type ShotTaskInput } from '../../shared/story-prompt.ts';
import { config } from '../config.ts';
import { db, newId, now, parseJson, type Row } from '../db.ts';
import { frameFromAsset } from '../library/frame.ts';
import { logger } from '../log.ts';
import { hasFfmpeg } from '../media/ffmpeg.ts';
import { registerJobKind } from '../jobs/runner.ts';
import { capabilities } from '../providers/index.ts';
import { onTaskSettled } from '../scheduler.ts';
import { createTasks, type TaskOrigin } from '../tasks/create.ts';
import { loadStory, snapshotStory } from './store.ts';

export type BatchScope = { type: 'all' } | { type: 'chapter'; id: string } | { type: 'scene'; id: string } | { type: 'shots'; ids: string[] };
export type BatchContent = 'keyframe' | 'video' | 'keyframe_then_video';
export type BatchMode = 'missing' | 'append' | 'redo';

export interface BatchRequest {
  scope: BatchScope;
  content: BatchContent;
  mode: BatchMode;
  /** 只在闲时时段（IDLE_WINDOW）开始派发 */
  idle?: boolean;
  resolution?: string;
}

export interface BatchPlan {
  /** 现在就会创建的任务 */
  items: { shotId: string; purpose: 'keyframe' | 'video'; firstFrame: string | null; type: string }[];
  /** 关键帧成功后才会创建的视频任务数 */
  followUps: number;
  /** 接续上一镜：等上一镜视频完成后才生成的镜头 */
  chained: { shotId: string; afterShotId: string }[];
  /** 最长的一串接续有多少段（含打头的那一镜），串里只能一段接一段地生成 */
  chainLongest: number;
  /** 设了接续但服务器没有 ffmpeg（截不了尾帧），这些镜头改用关键帧 */
  relayNoFfmpeg: number;
  skipped: { locked: number; noDescription: number; active: number; hasResult: number };
  tasks: number;
  gpuSeconds: number;
  /** 预计全部完成还要多久（含排在前面的任务） */
  etaSeconds: number;
  startsAt: number | null;
}

interface ShotRef {
  shot: Shot;
  sceneIndex: number;
  scene: StoryData['chapters'][number]['scenes'][number];
  prev: Shot | null;
}

function shotsInScope(data: StoryData, scope: BatchScope): ShotRef[] {
  const out: ShotRef[] = [];
  let prev: Shot | null = null;
  for (const chapter of data.chapters) {
    for (const [sceneIndex, scene] of chapter.scenes.entries()) {
      for (const shot of scene.shots) {
        const inScope =
          scope.type === 'all' ||
          (scope.type === 'chapter' && scope.id === chapter.id) ||
          (scope.type === 'scene' && scope.id === scene.id) ||
          (scope.type === 'shots' && scope.ids.includes(shot.id));
        if (inScope) out.push({ shot, scene, sceneIndex, prev });
        prev = shot;
      }
    }
  }
  return out;
}

/** 每个镜头当前的有效选定：显式选定优先，否则最新一张没被淘汰的候选 */
export function effectiveMedia(storyId: string): Map<string, { keyframe: string | null; video: string | null }> {
  const out = new Map<string, { keyframe: string | null; video: string | null }>();
  const rows = db
    .prepare(
      `SELECT shot_id, purpose, id FROM (
         SELECT shot_id, purpose, id, ROW_NUMBER() OVER (PARTITION BY shot_id, purpose ORDER BY seq DESC) AS rn
         FROM assets WHERE story_id = ? AND shot_id IS NOT NULL AND deleted_at IS NULL AND COALESCE(flag, '') <> 'reject'
       ) WHERE rn = 1`,
    )
    .all(storyId) as Row[];
  for (const row of rows) {
    const entry = out.get(String(row.shot_id)) ?? { keyframe: null, video: null };
    if (row.purpose === 'video') entry.video = String(row.id);
    else entry.keyframe = String(row.id);
    out.set(String(row.shot_id), entry);
  }
  for (const row of db.prepare('SELECT id, keyframe_asset_id, video_asset_id FROM story_shots WHERE story_id = ?').all(storyId) as Row[]) {
    const entry = out.get(String(row.id)) ?? { keyframe: null, video: null };
    if (row.keyframe_asset_id && isLive(String(row.keyframe_asset_id))) entry.keyframe = String(row.keyframe_asset_id);
    if (row.video_asset_id && isLive(String(row.video_asset_id))) entry.video = String(row.video_asset_id);
    out.set(String(row.id), entry);
  }
  return out;
}

function isLive(assetId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM assets WHERE id = ? AND deleted_at IS NULL').get(assetId));
}

function activeTasks(storyId: string): Set<string> {
  const rows = db.prepare("SELECT shot_id, purpose FROM tasks WHERE story_id = ? AND status IN ('queued', 'paused', 'running') AND shot_id IS NOT NULL").all(storyId) as Row[];
  return new Set(rows.map((row) => `${row.shot_id}:${row.purpose ?? 'keyframe'}`));
}

/** 闲时时段的下一次开始时间（IDLE_WINDOW，例如 01:00-07:00）；现在就在闲时内返回 0 */
export function nextIdleStart(at = new Date()): number {
  const [start, end] = config.idleWindow.split('-').map((part) => {
    const [h, m] = part.split(':').map(Number);
    return h * 60 + m;
  });
  const minutes = at.getHours() * 60 + at.getMinutes();
  const inside = start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  if (inside) return 0;
  const next = new Date(at);
  next.setHours(Math.floor(start / 60), start % 60, 0, 0);
  if (next.getTime() <= at.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/** 排在前面的任务大约还要多少秒（按并发数折算） */
function queueAheadSeconds(userId: string): number {
  const rows = db.prepare("SELECT type, params, status FROM tasks WHERE user_id = ? AND status IN ('queued', 'running')").all(userId) as Row[];
  const total = rows.reduce((sum, row) => sum + estimateSeconds(row.type as Task['type'], Number(parseJson<{ duration?: number }>(row.params, {}).duration ?? 5)) * (row.status === 'running' ? 0.5 : 1), 0);
  return total / Math.max(1, config.maxRunning);
}

function firstFrameFor(ref: ShotRef, media: Map<string, { keyframe: string | null; video: string | null }>): { assetId: string | null; fromPrevVideo: string | null } {
  const mode = ref.shot.firstFrame?.mode ?? 'keyframe';
  if (mode === 'asset' && ref.shot.firstFrame?.assetId && isLive(ref.shot.firstFrame.assetId)) return { assetId: ref.shot.firstFrame.assetId, fromPrevVideo: null };
  if (mode === 'prev_last' && ref.prev) {
    const prevVideo = media.get(ref.prev.id)?.video ?? null;
    if (prevVideo) return { assetId: null, fromPrevVideo: prevVideo };
  }
  return { assetId: media.get(ref.shot.id)?.keyframe ?? null, fromPrevVideo: null };
}

export function planBatch(storyId: string, userId: string, request: BatchRequest): BatchPlan {
  const { data } = loadStory(storyId);
  const media = effectiveMedia(storyId);
  const active = activeTasks(storyId);
  const plan: BatchPlan = { items: [], followUps: 0, chained: [], chainLongest: 0, relayNoFfmpeg: 0, skipped: { locked: 0, noDescription: 0, active: 0, hasResult: 0 }, tasks: 0, gpuSeconds: 0, etaSeconds: 0, startsAt: null };
  const ffmpeg = hasFfmpeg();
  /** 这次批量会出视频的镜头（马上建、关键帧之后建、接续之后建） */
  const videoComing = new Set<string>();
  /** 接续串里的位置：打头的镜头不在表里，第 n 个接续的是 n */
  const depth = new Map<string, number>();
  const waiting = waitingChains(storyId);
  for (const ref of shotsInScope(data, request.scope)) {
    const { shot } = ref;
    if (shot.locked) {
      plan.skipped.locked++;
      continue;
    }
    if (!shot.description.trim() && !shot.promptOverride?.trim()) {
      plan.skipped.noDescription++;
      continue;
    }
    const current = media.get(shot.id) ?? { keyframe: null, video: null };
    const wantKeyframe = request.content !== 'video';
    const wantVideo = request.content !== 'keyframe';
    const videoBlocked = active.has(`${shot.id}:video`) || waiting.has(shot.id) ? 'active' : request.mode === 'missing' && current.video ? 'hasResult' : null;
    // 接续上一镜：上一镜视频这次也会出（或正在出）就排在它后面；上一镜已有视频就直接截它的尾帧
    const relay = shot.firstFrame?.mode === 'prev_last' && ref.prev ? ref.prev.id : null;
    if (relay && !ffmpeg && wantVideo && !videoBlocked) plan.relayNoFfmpeg++;
    const prevComing = Boolean(relay && ffmpeg && (videoComing.has(relay) || active.has(`${relay}:video`) || waiting.has(relay)));
    const prevReady = Boolean(relay && ffmpeg && !prevComing && media.get(relay)?.video);
    const relayVideo = wantVideo && !videoBlocked && (prevComing || prevReady);
    let added = false;
    if (wantKeyframe && !(request.content === 'keyframe_then_video' && relayVideo)) {
      if (active.has(`${shot.id}:keyframe`)) plan.skipped.active++;
      else if (request.mode === 'missing' && current.keyframe) {
        if (!wantVideo) plan.skipped.hasResult++;
      } else {
        plan.items.push({ shotId: shot.id, purpose: 'keyframe', firstFrame: null, type: 't2i' });
        plan.gpuSeconds += estimateSeconds('t2i');
        added = true;
      }
    }
    if (wantVideo) {
      const keyframeComing = request.content === 'keyframe_then_video' && added;
      if (videoBlocked === 'active') plan.skipped.active++;
      else if (videoBlocked === 'hasResult') plan.skipped.hasResult++;
      else if (prevComing) {
        plan.chained.push({ shotId: shot.id, afterShotId: relay! });
        depth.set(shot.id, (depth.get(relay!) ?? 0) + 1);
        plan.gpuSeconds += estimateSeconds('i2v', shot.duration);
        videoComing.add(shot.id);
      } else if (keyframeComing) {
        plan.followUps++;
        plan.gpuSeconds += estimateSeconds('i2v', shot.duration);
        videoComing.add(shot.id);
      } else {
        videoComing.add(shot.id);
        const first = firstFrameFor(ref, media);
        plan.items.push({ shotId: shot.id, purpose: 'video', firstFrame: first.assetId ?? (first.fromPrevVideo ? `last:${first.fromPrevVideo}` : null), type: first.assetId || first.fromPrevVideo ? 'i2v' : 't2v' });
        plan.gpuSeconds += estimateSeconds('i2v', shot.duration);
      }
    }
  }
  plan.tasks = plan.items.length + plan.followUps + plan.chained.length;
  plan.chainLongest = depth.size ? Math.max(...depth.values()) + 1 : 0;
  const idleStart = request.idle ? nextIdleStart() : 0;
  plan.startsAt = idleStart || null;
  const waitIdle = idleStart ? Math.max(0, (idleStart - now()) / 1000) : 0;
  const ahead = waitIdle + queueAheadSeconds(userId);
  // 接续串只能一段接一段：最长那串的总时长是下限
  const serial = plan.chainLongest * estimateSeconds('i2v', 5);
  plan.etaSeconds = Math.round(ahead + Math.max(plan.gpuSeconds / Math.max(1, config.maxRunning), serial));
  return plan;
}

function isAdmin(userId: string): boolean {
  return (db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as Row | undefined)?.role === 'admin';
}

/** 执行批量：先存一份快照，再一次性创建任务（不受 200 条的限制） */
export async function runBatch(storyId: string, userId: string, request: BatchRequest): Promise<{ plan: BatchPlan; created: number }> {
  const plan = planBatch(storyId, userId, request);
  if (!plan.items.length && !plan.chained.length) return { plan, created: 0 };
  snapshotStory(storyId, 'before_batch');
  const { data } = loadStory(storyId);
  const caps = capabilities(isAdmin(userId));
  const byId = new Map(shotsInScope(data, { type: 'all' }).map((ref) => [ref.shot.id, ref]));
  const batchId = `bt_${now().toString(36)}`;
  const inputs: (ShotTaskInput & { runNow: boolean })[] = [];
  const origins: TaskOrigin[] = [];
  for (const item of plan.items) {
    const ref = byId.get(item.shotId);
    if (!ref) continue;
    let firstFrame: string | null = null;
    if (item.purpose === 'video' && item.firstFrame?.startsWith('last:')) {
      // 接续上一镜：截取上一镜视频的尾帧（缩放到算子需要的尺寸）作为首帧
      try {
        const task = buildShotTask(data, ref.scene, ref.shot, 'video', { storyId, caps, firstFrameAssetId: 'x' });
        const frame = await frameFromAsset(userId, item.firstFrame.slice(5), 'last', { size: { width: task.params.width, height: task.params.height }, storyId, shotId: null });
        firstFrame = frame.id;
      } catch (error) {
        logger.warn({ err: error, shotId: item.shotId }, '截取上一镜尾帧失败，改用关键帧');
        firstFrame = effectiveMedia(storyId).get(item.shotId)?.keyframe ?? null;
      }
    } else if (item.purpose === 'video') {
      firstFrame = item.firstFrame;
    }
    const task = buildShotTask(data, ref.scene, ref.shot, item.purpose, { storyId, caps, firstFrameAssetId: firstFrame, resolution: request.resolution });
    inputs.push({ ...task, runNow: !request.idle });
    origins.push({ kind: 'batch', id: batchId, step: request.content === 'keyframe_then_video' && item.purpose === 'keyframe' ? 'kv' : item.purpose });
  }
  // 按 origin 分组创建（同一组的 origin 相同）
  let created = 0;
  const groups = new Map<string, number[]>();
  origins.forEach((origin, index) => {
    const key = origin.step ?? '';
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const idleStart = request.idle ? nextIdleStart() : 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const indexes of groups.values()) {
      const result = createTasks({ id: userId, isAdmin: isAdmin(userId) }, indexes.map((i) => inputs[i]), origins[indexes[0]]);
      if (typeof result === 'string') throw new Error(result);
      created += result.length;
      if (idleStart) {
        for (const task of result) db.prepare('UPDATE tasks SET next_attempt_at = ?, manual_kick = 1 WHERE id = ?').run(idleStart, task.id);
      }
    }
    for (const chain of plan.chained) addChain(storyId, userId, chain.shotId, chain.afterShotId, { batchId, resolution: request.resolution ?? null, idle: Boolean(request.idle) });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { plan, created };
}

/** "先关键帧再视频"：关键帧任务成功后接着建这个镜头的视频任务 */
export function startBatchFollowUps(): () => void {
  return onTaskSettled((task) => {
    if (task.status !== 'succeeded' || task.link.purpose !== 'keyframe' || !task.link.storyId || !task.link.shotId) return;
    const row = db.prepare('SELECT user_id, origin FROM tasks WHERE id = ?').get(task.id) as Row | undefined;
    const origin = parseJson<TaskOrigin | null>(row?.origin, null);
    if (!row || origin?.kind !== 'batch' || origin.step !== 'kv') return;
    const storyId = task.link.storyId;
    const shotId = task.link.shotId;
    try {
      const story = db.prepare('SELECT schema, deleted_at FROM stories WHERE id = ?').get(storyId) as Row | undefined;
      if (!story || Number(story.schema) !== 2 || story.deleted_at != null) return;
      const { data } = loadStory(storyId);
      const ref = shotsInScope(data, { type: 'shots', ids: [shotId] })[0];
      if (!ref || ref.shot.locked) return;
      if (activeTasks(storyId).has(`${shotId}:video`)) return;
      const keyframe = task.outputAssetIds[0] ?? null;
      const media = effectiveMedia(storyId);
      const first = ref.shot.firstFrame?.mode === 'asset' ? firstFrameFor(ref, media).assetId : keyframe;
      const userId = String(row.user_id);
      const input = buildShotTask(data, ref.scene, ref.shot, 'video', { storyId, caps: capabilities(isAdmin(userId)), firstFrameAssetId: first });
      const result = createTasks({ id: userId, isAdmin: isAdmin(userId) }, [{ ...input, runNow: true }], { kind: 'batch', id: origin.id, step: 'video' });
      if (typeof result === 'string') logger.warn({ shotId, err: result }, '批量：创建视频任务失败');
    } catch (error) {
      logger.error({ err: error, taskId: task.id }, '批量：关键帧完成后创建视频任务失败');
    }
  });
}

// ---------------- 接续上一镜尾帧（story_chains） ----------------

/** 正在等上一镜的镜头 */
function waitingChains(storyId: string): Set<string> {
  return new Set((db.prepare("SELECT shot_id FROM story_chains WHERE story_id = ? AND status = 'waiting'").all(storyId) as Row[]).map((row) => String(row.shot_id)));
}

export function addChain(storyId: string, userId: string, shotId: string, afterShotId: string, options: { batchId?: string | null; resolution?: string | null; idle?: boolean } = {}): string {
  const ts = now();
  db.prepare("UPDATE story_chains SET status = 'canceled', updated_at = ? WHERE story_id = ? AND shot_id = ? AND status = 'waiting'").run(ts, storyId, shotId);
  const id = newId('chn_');
  db.prepare(
    `INSERT INTO story_chains (id, story_id, user_id, shot_id, after_shot_id, batch_id, resolution, idle, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`,
  ).run(id, storyId, userId, shotId, afterShotId, options.batchId ?? null, options.resolution ?? null, options.idle ? 1 : 0, ts, ts);
  return id;
}

export function cancelChain(storyId: string, shotId: string): boolean {
  const result = db.prepare("UPDATE story_chains SET status = 'canceled', updated_at = ? WHERE story_id = ? AND shot_id = ? AND status = 'waiting'").run(now(), storyId, shotId);
  return Number(result.changes) > 0;
}

export function listChains(storyId: string): { shotId: string; afterShotId: string; createdAt: number }[] {
  return (db.prepare("SELECT shot_id, after_shot_id, created_at FROM story_chains WHERE story_id = ? AND status = 'waiting' ORDER BY created_at").all(storyId) as Row[]).map((row) => ({
    shotId: String(row.shot_id),
    afterShotId: String(row.after_shot_id),
    createdAt: Number(row.created_at),
  }));
}

/** 上一镜在等待开始之后新出的视频（最新一条） */
function freshVideo(storyId: string, shotId: string, since: number): string | null {
  const row = db
    .prepare("SELECT id FROM assets WHERE story_id = ? AND shot_id = ? AND purpose = 'video' AND deleted_at IS NULL AND created_at >= ? ORDER BY seq DESC LIMIT 1")
    .get(storyId, shotId, since) as Row | undefined;
  return row ? String(row.id) : null;
}

/** 上一镜视频出来了：截尾帧，建这一镜的视频任务 */
async function fireChain(row: Row, video: string): Promise<void> {
  // 先占住，避免回调和保底扫描同时触发
  const claimed = db.prepare("UPDATE story_chains SET status = 'created', updated_at = ? WHERE id = ? AND status = 'waiting'").run(now(), String(row.id));
  if (!Number(claimed.changes)) return;
  const storyId = String(row.story_id);
  const shotId = String(row.shot_id);
  const userId = String(row.user_id);
  const note = (text: string, taskId: string | null = null) => db.prepare('UPDATE story_chains SET note = ?, task_id = ?, updated_at = ? WHERE id = ?').run(text, taskId, now(), String(row.id));
  try {
    const story = db.prepare('SELECT schema, deleted_at FROM stories WHERE id = ?').get(storyId) as Row | undefined;
    if (!story || Number(story.schema) !== 2 || story.deleted_at != null) return void note('故事已删除');
    const { data } = loadStory(storyId);
    const ref = shotsInScope(data, { type: 'shots', ids: [shotId] })[0];
    if (!ref) return void note('镜头已删除');
    if (ref.shot.locked) return void note('镜头已定稿');
    if (activeTasks(storyId).has(`${shotId}:video`)) return void note('这一镜已经有进行中的视频任务');
    if (freshVideo(storyId, shotId, Number(row.created_at))) return void note('这一镜在等待期间已经手动生成过视频');
    const caps = capabilities(isAdmin(userId));
    const resolution = (row.resolution as string | null) ?? undefined;
    let first: string | null = null;
    try {
      const probe = buildShotTask(data, ref.scene, ref.shot, 'video', { storyId, caps, firstFrameAssetId: 'x', resolution });
      first = (await frameFromAsset(userId, video, 'last', { size: { width: probe.params.width, height: probe.params.height }, storyId, shotId: null })).id;
    } catch (error) {
      logger.warn({ err: error, shotId }, '接续：截取上一镜尾帧失败，改用关键帧');
      first = effectiveMedia(storyId).get(shotId)?.keyframe ?? null;
    }
    const input = buildShotTask(data, ref.scene, ref.shot, 'video', { storyId, caps, firstFrameAssetId: first, resolution });
    const idle = Number(row.idle) === 1;
    const result = createTasks({ id: userId, isAdmin: isAdmin(userId) }, [{ ...input, runNow: !idle }], { kind: 'batch', id: String(row.batch_id ?? row.id), step: 'chain' });
    if (typeof result === 'string') return void note(`创建视频任务失败：${result}`);
    if (idle) {
      const start = nextIdleStart();
      if (start) db.prepare('UPDATE tasks SET next_attempt_at = ?, manual_kick = 1 WHERE id = ?').run(start, result[0].id);
    }
    note(first ? '已接续上一镜尾帧' : '截帧失败，没有首帧', result[0].id);
  } catch (error) {
    logger.error({ err: error, chain: row.id }, '接续：建下一镜视频任务失败');
    note(`出错：${(error as Error).message}`);
  }
}

/** 某个镜头出了新视频：触发等它的接续 */
async function onShotVideo(storyId: string, shotId: string, video: string): Promise<void> {
  const rows = db.prepare("SELECT * FROM story_chains WHERE story_id = ? AND after_shot_id = ? AND status = 'waiting'").all(storyId, shotId) as Row[];
  for (const row of rows) await fireChain(row, video);
}

/** 保底扫描：漏掉的回调（重启、上一镜视频是手动上传或选定的）——上一镜在等待开始后有了新视频就接上 */
export async function sweepChains(): Promise<void> {
  const rows = db.prepare("SELECT * FROM story_chains WHERE status = 'waiting' ORDER BY created_at LIMIT 200").all() as Row[];
  for (const row of rows) {
    const video = freshVideo(String(row.story_id), String(row.after_shot_id), Number(row.created_at));
    if (video) await fireChain(row, video);
  }
}

export function startStoryChains(): () => void {
  const off = onTaskSettled((task) => {
    if (task.status !== 'succeeded' || task.link.purpose !== 'video' || !task.link.storyId || !task.link.shotId || !task.outputAssetIds[0]) return;
    void onShotVideo(task.link.storyId, task.link.shotId, task.outputAssetIds[0]).catch((error) => logger.error({ err: error }, '接续：回调失败'));
  });
  const timer = setInterval(() => void sweepChains().catch((error) => logger.error({ err: error }, '接续：保底扫描失败')), 30_000);
  timer.unref();
  void sweepChains().catch(() => undefined);
  return () => {
    off();
    clearInterval(timer);
  };
}

// ---------------- 批量前先用 AI 写视频分镜提示词 ----------------

/** 这次批量里要出视频、还没写过 AI 分镜的镜头（手写了完整提示词的不动） */
export function storyboardTargets(storyId: string, request: BatchRequest): ShotRef[] {
  if (request.content === 'keyframe') return [];
  const { data } = loadStory(storyId);
  const media = request.mode === 'missing' ? effectiveMedia(storyId) : null;
  return shotsInScope(data, request.scope).filter(
    (ref) =>
      !ref.shot.locked &&
      !ref.shot.promptOverride?.trim() &&
      !ref.shot.storyboard?.trim() &&
      ref.shot.description.trim() &&
      !(media && media.get(ref.shot.id)?.video),
  );
}

export function registerStoryboardJob(): void {
  registerJobKind<{ storyId: string; userId: string; request: BatchRequest }>('story-storyboard', {
    maxAttempts: 1,
    handler: async (ctx) => {
      const { storyId, userId, request } = ctx.payload;
      const { runAssist } = await import('../assist.ts');
      const { commitOps } = await import('../routes/stories.ts');
      const targets = storyboardTargets(storyId, request);
      let written = 0;
      let failed = 0;
      for (const [index, ref] of targets.entries()) {
        if (ctx.signal.aborted) return { written, failed, created: 0, canceled: true };
        ctx.progress(index / Math.max(1, targets.length), `写分镜 ${index + 1}/${targets.length}`);
        try {
          // 用自动拼好的视频提示词当"场景"（带上了角色外貌、地点、景别运镜）
          const { data } = loadStory(storyId);
          const fresh = shotsInScope(data, { type: 'shots', ids: [ref.shot.id] })[0];
          if (!fresh || fresh.shot.storyboard?.trim()) continue;
          const scene = buildShotPrompt(data, fresh.scene, fresh.shot, { purpose: 'video' }).prompt;
          const result = await runAssist('storyboard', { scene, duration: fresh.shot.duration || 5 });
          const prompt = typeof result.prompt === 'string' ? result.prompt.trim() : '';
          if (!prompt) throw new Error('没有返回内容');
          commitOps(storyId, userId, [{ op: 'set', entity: 'shot', id: fresh.shot.id, patch: { storyboard: prompt.slice(0, 4000) } }], null);
          written++;
        } catch (error) {
          // 写不出来的镜头照常用自动拼的提示词
          failed++;
          logger.warn({ err: error, shotId: ref.shot.id }, '批量：AI 写分镜失败，改用自动提示词');
        }
      }
      ctx.progress(1, '开始生成');
      const result = await runBatch(storyId, userId, request);
      return { written, failed, created: result.created, chained: result.plan.chained.length };
    },
  });
}
