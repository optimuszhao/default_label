// 工作流执行引擎（WF-01）：
//   - 运行的每一步状态都存在 workflow_runs.state 里，服务重启后接着跑（llm、local 步骤重新执行，它们是幂等的）
//   - 生成步骤转成普通任务进队列，复用调度、重试、公平排队；任务结束（onTaskSettled）时推进，另有 30 秒保底扫描
//   - 每个运行加锁串行推进；支持暂停、继续、取消（级联取消名下排队中的任务）、单步重试、跳过、人工挑选
//   - 上限：每人 3 个活跃运行，每个运行最多 60 个任务，单步 forEach 最多 24 项
import fs from 'node:fs/promises';
import { ASPECT_RATIOS, resolveSize } from '../../shared/operator.ts';
import type { WorkflowRun } from '../../shared/types.ts';
import { runAssist } from '../assist.ts';
import { publish } from '../bus.ts';
import { db, newId, now, parseJson, type Row } from '../db.ts';
import { absoluteFile, indexAsset, newTempFile, saveAsset } from '../files.ts';
import { frameFromAsset } from '../library/frame.ts';
import { logger } from '../log.ts';
import { concatVideos } from '../media/concat.ts';
import { hasFfmpeg } from '../media/ffmpeg.ts';
import { capabilities } from '../providers/index.ts';
import { getAssetRow } from '../repo.ts';
import { onTaskSettled } from '../scheduler.ts';
import { cancelTaskById, createTasks } from '../tasks/create.ts';
import { WORKFLOWS } from './defs.ts';
import { LIMITS, type RunContext, type StepState, type TaskSpec, type WorkflowDef, type WorkflowStep } from './types.ts';

export function findWorkflow(id: string): WorkflowDef | null {
  return WORKFLOWS.find((def) => def.id === id) ?? null;
}

export function workflowSettings(): Map<string, { enabled: boolean; sort: number; defaults: Record<string, unknown> }> {
  const rows = db.prepare('SELECT * FROM workflow_settings').all() as Row[];
  return new Map(rows.map((row) => [String(row.workflow_id), { enabled: Number(row.enabled) === 1, sort: Number(row.sort), defaults: parseJson(row.defaults, {}) }]));
}

function emptyState(): StepState {
  return { status: 'pending', assets: [], taskIds: [] };
}

export function toRun(row: Row): WorkflowRun {
  const def = findWorkflow(String(row.workflow_id));
  const state = parseJson<Record<string, StepState>>(row.state, {});
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    title: String(row.title),
    status: row.status as WorkflowRun['status'],
    inputs: parseJson(row.inputs, {}),
    unattended: Number(row.unattended) === 1,
    taskCount: Number(row.task_count),
    error: (row.error as string | null) ?? null,
    steps: (def?.steps ?? []).map((step) => {
      const st = state[step.id] ?? emptyState();
      return {
        id: step.id,
        kind: step.kind,
        label: step.label,
        status: st.status,
        assets: st.assets,
        taskIds: st.taskIds,
        note: st.note ?? null,
        error: st.error ?? null,
        ...(step.kind === 'select' ? { from: step.from, min: step.min, max: step.max, hint: step.hint ?? null } : {}),
      };
    }),
    outputs: (def?.outputs ?? []).flatMap((id) => state[id]?.assets ?? []),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
  };
}

function save(runId: string, fields: { status?: string; state?: Record<string, StepState>; error?: string | null; taskCount?: number; finished?: boolean }): void {
  const sets: string[] = ['updated_at = ?'];
  const args: (string | number | null)[] = [now()];
  if (fields.status) {
    sets.push('status = ?');
    args.push(fields.status);
  }
  if (fields.state) {
    sets.push('state = ?');
    args.push(JSON.stringify(fields.state));
  }
  if (fields.error !== undefined) {
    sets.push('error = ?');
    args.push(fields.error);
  }
  if (fields.taskCount !== undefined) {
    sets.push('task_count = ?');
    args.push(fields.taskCount);
  }
  if (fields.finished) {
    sets.push('finished_at = ?');
    args.push(now());
  }
  db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`).run(...args, runId);
  const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as Row | undefined;
  if (row) publish(String(row.user_id), { type: 'workflow-run', run: toRun(row) });
}

function isAdmin(userId: string): boolean {
  return (db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as Row | undefined)?.role === 'admin';
}

/** 素材的宽高比最接近的标准比例（接力时用起始画面的比例） */
function ratioOf(assetId: string | null | undefined): string | null {
  const row = assetId ? getAssetRow(assetId) : null;
  if (!row?.width || !row?.height) return null;
  const value = Number(row.width) / Number(row.height);
  let best = '16:9';
  let diff = Infinity;
  for (const ratio of ASPECT_RATIOS) {
    const [w, h] = ratio.split(':').map(Number);
    const d = Math.abs(w / h - value);
    if (d < diff) {
      diff = d;
      best = ratio;
    }
  }
  return best;
}

/** 任务描述 → 创建任务的输入（走配方编译，预设和模板与创作台一致） */
async function specToInput(spec: TaskSpec, userId: string) {
  const video = spec.type === 't2v' || spec.type === 'i2v';
  const caps = capabilities(isAdmin(userId));
  let firstFrame: string | null = null;
  const source = spec.inputs?.firstFrame;
  let aspectRatio = spec.params.aspectRatio ?? null;
  if (typeof source === 'string') {
    firstFrame = source;
    aspectRatio ??= ratioOf(source);
  } else if (source && 'lastFrameOf' in source) {
    // 接力：截取上一段视频的尾帧，缩放到算子需要的输入尺寸
    aspectRatio ??= ratioOf(source.lastFrameOf);
    const size = resolveSize(caps.video, aspectRatio ?? '16:9', spec.params.resolution ?? '720p');
    const frame = await frameFromAsset(userId, source.lastFrameOf, 'last', { size });
    firstFrame = frame.id;
  }
  aspectRatio ??= '16:9';
  const resolution = spec.params.resolution ?? (video ? '720p' : '1k');
  const size = resolveSize(video ? caps.video : caps.image, aspectRatio, resolution);
  return {
    type: spec.type,
    title: spec.title,
    prompt: '',
    params: { aspectRatio, resolution, ...size, count: 1, seed: spec.params.seed ?? null, ...(video ? { duration: spec.params.duration ?? 5 } : {}) },
    inputs: { firstFrameAssetId: firstFrame, referenceAssetIds: spec.inputs?.references },
    recipe: {
      version: 1,
      mode: video ? ('video' as const) : ('image' as const),
      text: spec.prompt,
      presets: spec.presets ?? [],
      negative: spec.negative ?? '',
      overrides: { aspectRatio, resolution, count: 1, ...(video ? { duration: spec.params.duration ?? 5 } : {}), seed: spec.params.seed ?? null },
      parentAssetId: firstFrame,
    },
    runNow: true,
  };
}

class StepError extends Error {}

/** 生成步骤：建任务（并行一次建完；串行只建下一项） */
async function launch(run: Row, def: WorkflowDef, step: Extract<WorkflowStep, { kind: 'generate' }>, ctx: RunContext, st: StepState): Promise<number> {
  const items = step.forEach ? step.forEach.over(ctx) : [null];
  if (items.length > LIMITS.forEachItems) throw new StepError(`一步最多 ${LIMITS.forEachItems} 项`);
  if (!items.length) throw new StepError('没有可生成的内容');
  const sequential = step.forEach?.mode === 'sequential';
  const indexes = sequential ? [st.cursor ?? 0] : items.map((_, i) => i);
  const count = Number(run.task_count) + indexes.length;
  if (count > LIMITS.tasksPerRun) throw new StepError(`一个运行最多 ${LIMITS.tasksPerRun} 个任务`);
  const userId = String(run.user_id);
  const inputs = [];
  for (const index of indexes) inputs.push(await specToInput(step.task(ctx, items[index], index, st), userId));
  const result = createTasks({ id: userId, isAdmin: isAdmin(userId) }, inputs, { kind: 'workflow', id: String(run.id), step: step.id });
  if (typeof result === 'string') throw new StepError(result);
  st.taskIds = sequential ? [...st.taskIds, ...result.map((t) => t.id)] : result.map((t) => t.id);
  st.status = 'running';
  st.startedAt ??= now();
  void def;
  return count;
}

/** 生成步骤的任务都结束了吗：返回 'wait' / 'failed' / 'next'（串行还有下一项）/ 'done' */
function collect(step: Extract<WorkflowStep, { kind: 'generate' }>, ctx: RunContext, st: StepState): 'wait' | 'failed' | 'next' | 'done' {
  const rows = st.taskIds.map((id) => db.prepare('SELECT id, status, output_asset_ids, last_error FROM tasks WHERE id = ?').get(id) as Row | undefined);
  if (rows.some((row) => !row)) {
    st.error = '任务已被删除';
    return 'failed';
  }
  if (rows.some((row) => ['queued', 'paused', 'running'].includes(String(row!.status)))) return 'wait';
  const bad = rows.find((row) => row!.status !== 'succeeded');
  if (bad) {
    st.error = bad.status === 'canceled' ? '任务被取消' : String(bad.last_error ?? '生成失败');
    return 'failed';
  }
  st.assets = rows.flatMap((row) => parseJson<string[]>(row!.output_asset_ids, []));
  if (step.forEach?.mode === 'sequential') {
    const total = step.forEach.over(ctx).length;
    st.cursor = st.taskIds.length;
    if (st.cursor < total) return 'next';
  }
  return 'done';
}

async function runLocal(run: Row, step: Extract<WorkflowStep, { kind: 'local' }>, ctx: RunContext, st: StepState): Promise<void> {
  const userId = String(run.user_id);
  const source = step.source(ctx).filter(Boolean);
  if (step.op === 'concat_videos') {
    if (!hasFfmpeg()) {
      st.status = 'skipped';
      st.note = '服务器没有 ffmpeg，没有拼接；各段视频在上一步里';
      return;
    }
    if (source.length < 2) {
      st.assets = source;
      st.status = 'done';
      return;
    }
    const temp = await newTempFile('mp4');
    try {
      const clips = source.map((id) => ({ file: absoluteFile(String(getAssetRow(id)!.file)) }));
      const result = await concatVideos(clips, temp);
      const asset = await saveAsset({
        userId,
        kind: 'video',
        source: 'generated',
        mime: 'video/mp4',
        filePath: temp,
        prompt: `长镜头接力（${source.length} 段）`,
        parentAssetId: source[0],
        lineage: 'derive',
        note: `由 ${source.length} 段视频${result.mode === 'copy' ? '无损' : '重编码'}拼接`,
      });
      st.assets = [asset.id];
      st.status = 'done';
    } finally {
      await fs.rm(temp, { force: true });
    }
    return;
  }
  if (step.op === 'set_character_ref') {
    const [storyId, characterId] = String(ctx.inputs.character ?? '').split(':');
    const assetId = source[0];
    if (!storyId || !characterId || !assetId) {
      st.status = 'skipped';
      st.note = '没有选择故事角色';
      return;
    }
    const story = db.prepare('SELECT id FROM stories WHERE id = ? AND user_id = ? AND schema = 2 AND deleted_at IS NULL').get(storyId, userId) as Row | undefined;
    if (!story) throw new StepError('故事不存在');
    const { commitOps } = await import('../routes/stories.ts');
    commitOps(storyId, userId, [{ op: 'set', entity: 'character', id: characterId, patch: { referenceAssetId: assetId } }], null);
    // 4 张定妆照都挂到这个角色下，作为它的候选
    const shots = ctx.steps.shots?.assets ?? [];
    for (const id of shots) db.prepare("UPDATE assets SET story_id = ?, shot_id = ?, purpose = 'keyframe' WHERE id = ? AND story_id IS NULL").run(storyId, `char_${characterId}`, id);
    indexAsset(...shots);
    st.assets = [assetId];
    st.status = 'done';
  }
}

async function advanceNow(runId: string): Promise<void> {
  const run = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as Row | undefined;
  if (!run || run.status !== 'running') return;
  const def = findWorkflow(String(run.workflow_id));
  if (!def) {
    save(runId, { status: 'failed', error: '工作流已下线', finished: true });
    return;
  }
  const state = parseJson<Record<string, StepState>>(run.state, {});
  const ctx: RunContext = { inputs: parseJson(run.inputs, {}), steps: state, userId: String(run.user_id) };
  let taskCount = Number(run.task_count);
  for (const step of def.steps) {
    const st = (state[step.id] ??= emptyState());
    if (st.status === 'done' || st.status === 'skipped') continue;
    if (st.status === 'failed') {
      save(runId, { status: 'failed', state, error: `「${step.label}」失败：${st.error ?? ''}`, finished: true });
      return;
    }
    try {
      if (step.kind === 'generate') {
        if (st.status === 'pending') {
          taskCount = await launch({ ...run, task_count: taskCount }, def, step, ctx, st);
          save(runId, { state, taskCount });
          return;
        }
        const result = collect(step, ctx, st);
        if (result === 'wait') return;
        if (result === 'failed') {
          st.status = 'failed';
          save(runId, { status: 'failed', state, error: `「${step.label}」失败：${st.error}`, finished: true });
          return;
        }
        if (result === 'next') {
          taskCount = await launch({ ...run, task_count: taskCount }, def, step, ctx, st);
          save(runId, { state, taskCount });
          return;
        }
        st.status = 'done';
        st.finishedAt = now();
        continue;
      }
      if (step.kind === 'select') {
        const from = state[step.from]?.assets ?? [];
        if (Number(run.unattended) === 1 && step.auto === 'first') {
          st.assets = from.slice(0, Math.max(step.min, 1));
          st.status = 'done';
          st.note = '无人值守，自动选了第一张';
          continue;
        }
        if (st.status !== 'waiting') {
          st.status = 'waiting';
          save(runId, { status: 'waiting', state });
        }
        return;
      }
      if (step.kind === 'llm') {
        st.status = 'running';
        let lastError: Error | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            st.output = await runAssist(step.assist, step.input(ctx));
            lastError = null;
            break;
          } catch (error) {
            lastError = error as Error;
          }
        }
        if (lastError) throw new StepError(`AI 调用失败：${lastError.message}`);
        st.status = 'done';
        continue;
      }
      if (step.kind === 'local') {
        if (step.optional && !step.optional(ctx)) {
          st.status = 'skipped';
          st.note = '没有选择故事角色，跳过';
          continue;
        }
        st.status = 'running';
        await runLocal(run, step, ctx, st);
        continue;
      }
    } catch (error) {
      st.status = 'failed';
      st.error = (error as Error).message;
      logger.warn({ runId, step: step.id, err: st.error }, '工作流步骤失败');
      save(runId, { status: 'failed', state, error: `「${step.label}」失败：${st.error}`, finished: true });
      return;
    }
  }
  save(runId, { status: 'succeeded', state, finished: true });
}

const locks = new Map<string, Promise<void>>();

/** 推进一个运行：同一个运行串行执行，不会并发推进 */
export function advance(runId: string): Promise<void> {
  const previous = locks.get(runId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => advanceNow(runId))
    .catch((error) => logger.error({ err: error, runId }, '推进工作流失败'))
    .finally(() => {
      if (locks.get(runId) === next) locks.delete(runId);
    });
  locks.set(runId, next);
  return next;
}

export interface StartOptions {
  title?: string;
  unattended?: boolean;
}

export function validateInputs(def: WorkflowDef, raw: Record<string, unknown>, userId: string): Record<string, unknown> | string {
  const settings = workflowSettings().get(def.id);
  const out: Record<string, unknown> = {};
  for (const input of def.inputs) {
    let value = raw[input.key] ?? settings?.defaults[input.key] ?? input.default;
    if (input.type === 'lines') {
      const lines = (Array.isArray(value) ? value : String(value ?? '').split('\n')).map((l) => String(l).trim()).filter(Boolean);
      if (input.min && lines.length < input.min) return `「${input.label}」至少 ${input.min} 行`;
      if (input.max && lines.length > input.max) return `「${input.label}」最多 ${input.max} 行`;
      value = lines;
    } else if (input.type === 'image') {
      if (value) {
        const row = getAssetRow(String(value));
        if (!row || row.user_id !== userId || row.deleted_at != null || row.kind !== 'image') return `「${input.label}」请选一张图片`;
      }
    } else if (input.type === 'select') {
      if (input.options && value != null && !input.options.map(String).includes(String(value))) return `「${input.label}」的取值不对`;
    } else if (value != null) {
      value = String(value).slice(0, 2000);
    }
    if (input.required && (value == null || value === '' || (Array.isArray(value) && !value.length))) return `请填写「${input.label}」`;
    out[input.key] = value ?? null;
  }
  return out;
}

export async function startRun(userId: string, def: WorkflowDef, rawInputs: Record<string, unknown>, options: StartOptions = {}): Promise<WorkflowRun | string> {
  const settings = workflowSettings().get(def.id);
  if (settings && !settings.enabled) return '这个工作流已停用';
  const active = Number((db.prepare(`SELECT COUNT(*) AS n FROM workflow_runs WHERE user_id = ? AND status IN ('running', 'waiting', 'paused')`).get(userId) as Row).n);
  if (active >= LIMITS.activeRunsPerUser) return `同时最多 ${LIMITS.activeRunsPerUser} 个进行中的工作流，请等前面的完成或取消`;
  const inputs = validateInputs(def, rawInputs, userId);
  if (typeof inputs === 'string') return inputs;
  const id = newId('wr_');
  const title = (options.title?.trim() || `${def.title} · ${String(inputs.idea ?? inputs.name ?? (Array.isArray(inputs.beats) ? inputs.beats[0] : '') ?? '').slice(0, 24)}`).slice(0, 80);
  const state = Object.fromEntries(def.steps.map((step) => [step.id, emptyState()]));
  db.prepare(
    `INSERT INTO workflow_runs (id, user_id, workflow_id, title, status, inputs, state, unattended, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
  ).run(id, userId, def.id, title, JSON.stringify(inputs), JSON.stringify(state), options.unattended ? 1 : 0, now(), now());
  await advance(id);
  return toRun(db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as Row);
}

/** 人工挑选 */
export async function selectAssets(run: Row, stepId: string, assetIds: string[]): Promise<string | null> {
  const def = findWorkflow(String(run.workflow_id));
  const step = def?.steps.find((s) => s.id === stepId);
  if (!def || !step || step.kind !== 'select') return '步骤不存在';
  const state = parseJson<Record<string, StepState>>(run.state, {});
  const st = state[stepId];
  if (!st || st.status !== 'waiting') return '这一步现在不需要挑选';
  const from = state[step.from]?.assets ?? [];
  if (!assetIds.every((id) => from.includes(id))) return '只能从上一步的结果里挑';
  if (assetIds.length < step.min || assetIds.length > step.max) return step.min === step.max ? `请挑 ${step.min} 张` : `请挑 ${step.min}–${step.max} 张`;
  st.assets = assetIds;
  st.status = 'done';
  save(String(run.id), { status: 'running', state });
  await advance(String(run.id));
  return null;
}

/** 单步重试：这一步和后面的步骤回到待执行（之前的产物保留在资产库里） */
export async function retryStep(run: Row, stepId: string): Promise<string | null> {
  const def = findWorkflow(String(run.workflow_id));
  const index = def?.steps.findIndex((s) => s.id === stepId) ?? -1;
  if (!def || index < 0) return '步骤不存在';
  if (!['failed', 'running', 'waiting'].includes(String(run.status))) return '只有失败或进行中的工作流可以重试步骤';
  const state = parseJson<Record<string, StepState>>(run.state, {});
  for (const step of def.steps.slice(index)) {
    for (const taskId of state[step.id]?.taskIds ?? []) await cancelTaskById(taskId);
    state[step.id] = emptyState();
  }
  save(String(run.id), { status: 'running', state, error: null });
  db.prepare('UPDATE workflow_runs SET finished_at = NULL WHERE id = ?').run(String(run.id));
  await advance(String(run.id));
  return null;
}

/** 跳过一步（失败或等待中的步骤） */
export async function skipStep(run: Row, stepId: string): Promise<string | null> {
  const def = findWorkflow(String(run.workflow_id));
  if (!def?.steps.some((s) => s.id === stepId)) return '步骤不存在';
  const state = parseJson<Record<string, StepState>>(run.state, {});
  const st = state[stepId];
  if (!st || !['failed', 'waiting', 'pending'].includes(st.status)) return '这一步不能跳过';
  st.status = 'skipped';
  st.note = '已手动跳过';
  save(String(run.id), { status: 'running', state, error: null });
  db.prepare('UPDATE workflow_runs SET finished_at = NULL WHERE id = ?').run(String(run.id));
  await advance(String(run.id));
  return null;
}

/** 取消：名下排队、暂停、生成中的任务一起取消 */
export async function cancelRun(run: Row): Promise<void> {
  const state = parseJson<Record<string, StepState>>(run.state, {});
  save(String(run.id), { status: 'canceled', finished: true });
  for (const st of Object.values(state)) for (const taskId of st.taskIds) await cancelTaskById(taskId);
}

export function pauseRun(run: Row): void {
  if (run.status === 'running' || run.status === 'waiting') {
    // 暂停：名下还在排队的任务也暂停
    const state = parseJson<Record<string, StepState>>(run.state, {});
    for (const st of Object.values(state)) for (const taskId of st.taskIds) db.prepare("UPDATE tasks SET status = 'paused', manual_kick = 0 WHERE id = ? AND status = 'queued'").run(taskId);
    save(String(run.id), { status: 'paused' });
  }
}

export async function resumeRun(run: Row): Promise<void> {
  if (run.status !== 'paused') return;
  const state = parseJson<Record<string, StepState>>(run.state, {});
  for (const st of Object.values(state)) for (const taskId of st.taskIds) db.prepare("UPDATE tasks SET status = 'queued', next_attempt_at = 0, manual_kick = 1 WHERE id = ? AND status = 'paused'").run(taskId);
  const waiting = Object.values(state).some((st) => st.status === 'waiting');
  save(String(run.id), { status: waiting ? 'waiting' : 'running' });
  const { kickScheduler } = await import('../scheduler.ts');
  kickScheduler();
  await advance(String(run.id));
}

/** 启动：任务结束时推进；每 30 秒保底扫一遍；重启前正在执行的 llm / local 步骤重新执行 */
export function startWorkflows(): () => void {
  for (const row of db.prepare("SELECT id, workflow_id, state FROM workflow_runs WHERE status = 'running'").all() as Row[]) {
    const def = findWorkflow(String(row.workflow_id));
    const state = parseJson<Record<string, StepState>>(row.state, {});
    let changed = false;
    for (const [stepId, st] of Object.entries(state)) {
      const kind = def?.steps.find((s) => s.id === stepId)?.kind;
      if (st.status === 'running' && (kind === 'llm' || kind === 'local' || !kind)) {
        st.status = 'pending';
        changed = true;
      }
    }
    if (changed) db.prepare('UPDATE workflow_runs SET state = ? WHERE id = ?').run(JSON.stringify(state), String(row.id));
  }
  const stop = onTaskSettled((task) => {
    const row = db.prepare('SELECT origin FROM tasks WHERE id = ?').get(task.id) as Row | undefined;
    const origin = parseJson<{ kind?: string; id?: string } | null>(row?.origin, null);
    if (origin?.kind === 'workflow' && origin.id) void advance(origin.id);
  });
  const sweep = () => {
    for (const row of db.prepare("SELECT id FROM workflow_runs WHERE status = 'running'").all() as Row[]) void advance(String(row.id));
  };
  const timer = setInterval(sweep, 30_000);
  timer.unref();
  setTimeout(sweep, 2000).unref();
  return () => {
    stop();
    clearInterval(timer);
  };
}
