// 创建生成任务的统一入口：校验 → 编译配方 → 按算子能力规整 → 入库 → 唤醒调度器。
// 创作台（接口）、故事批量、工作流都走这里，规则只有一套。
import { z } from 'zod';
import { compose } from '../../shared/compose.ts';
import { clampDuration, resolveSize } from '../../shared/operator.ts';
import type { Task } from '../../shared/types.ts';
import { getTemplate, presetMap, recordTemplateUse } from '../catalog.ts';
import { config } from '../config.ts';
import { db, newId, now, type Row } from '../db.ts';
import { capabilities } from '../providers/index.ts';
import { getTask } from '../repo.ts';
import { kickScheduler } from '../scheduler.ts';
import { ownsAsset } from '../routes/common.ts';

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

export const taskSchema = z.object({
  type: z.enum(['t2i', 'i2i', 't2v', 'i2v']),
  title: z.string().max(120).optional(),
  /** 有配方时由服务端编译，可以不传 */
  prompt: z.string().trim().max(4000).default(''),
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
  recipe: z
    .object({
      version: z.number().int().default(1),
      mode: z.enum(['image', 'video']),
      text: z.string().max(4000).default(''),
      templateId: z.string().max(80).nullable().optional(),
      vars: z.record(z.string(), z.string().max(200)).optional(),
      presets: z.array(z.string().max(80)).max(40).default([]),
      negative: z.string().max(2000).default(''),
      overrides: z
        .object({
          aspectRatio: z.string().max(10).optional(),
          resolution: z.string().max(10).optional(),
          count: z.number().int().min(1).max(4).optional(),
          duration: z.number().min(1).max(30).optional(),
          seed: z.number().int().nullable().optional(),
          steps: z.number().int().min(1).max(150).optional(),
          cameraMotion: z.string().max(60).optional(),
        })
        .default({}),
      parentAssetId: z.string().max(40).nullable().optional(),
    })
    .optional(),
});

/** 任务来源：故事批量、工作流（用于取消时级联、结束时推进） */
export interface TaskOrigin {
  kind: 'batch' | 'workflow';
  id: string;
  step?: string;
}

export function insertTask(userId: string, input: z.infer<typeof taskSchema>, origin?: TaskOrigin): Task {
  const id = newId('t_');
  const ts = now();
  db.prepare(
    `INSERT INTO tasks (id, user_id, type, status, title, prompt, negative_prompt, params, inputs, story_id, shot_id, purpose,
       max_attempts, priority, next_attempt_at, manual_kick, recipe, origin, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    input.recipe ? JSON.stringify(input.recipe) : null,
    origin ? JSON.stringify(origin) : null,
    ts,
    ts,
  );
  return getTask(id)!;
}

export type TaskInput = z.infer<typeof taskSchema>;

/**
 * 有配方时用编译器生成最终提示词和参数（和前端预览同一套逻辑，以服务端为准），
 * 记录模板使用；返回错误文字或编译后的任务输入。
 */
export function compileRecipe(userId: string, input: TaskInput, isAdmin: boolean): TaskInput | string {
  const recipe = input.recipe;
  if (!recipe) return input.prompt ? input : '请输入提示词';
  const template = getTemplate(recipe.templateId);
  if (recipe.templateId && !template) return '模板不存在或已下架';
  const video = input.type === 't2v' || input.type === 'i2v';
  if ((recipe.mode === 'video') !== video) return '配方模式和任务类型不一致';
  if (recipe.parentAssetId && !ownsAsset(userId, recipe.parentAssetId)) return '来源素材不存在';
  const result = compose({ recipe: { ...recipe, vars: recipe.vars ?? {} }, template, catalog: presetMap(), caps: capabilities(isAdmin) });
  if (!result.prompt) return '请输入提示词，或选择一个模板';
  if (template) recordTemplateUse(template.id, userId);
  return {
    ...input,
    title: input.title || (template ? `${template.name} · ${result.prompt.slice(0, 24)}` : undefined),
    prompt: result.prompt,
    negativePrompt: result.negativePrompt,
    params: { ...result.params, model: input.params.model },
  };
}

/**
 * 按算子能力规整参数：去掉不起作用的参数，尺寸、时长、张数收进支持范围。
 * 前端已经按能力隐藏了控件，这里兜底旧客户端和故事批量生成。
 */
export function normalizeTask(input: TaskInput, isAdmin = false): TaskInput {
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

export function validateTaskInput(userId: string, input: z.infer<typeof taskSchema>): string | null {
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

export interface CreateUser {
  id: string;
  isAdmin: boolean;
}

/**
 * 校验并创建一批任务。任何一条不合法时一条都不创建，返回错误文字。
 * 输入先过 taskSchema（服务端调用方也用它补默认值），再做归属、配方、能力规整。
 */
export function createTasks(user: CreateUser, items: z.input<typeof taskSchema>[], origin?: TaskOrigin): Task[] | string {
  const compiled: TaskInput[] = [];
  for (const raw of items) {
    const parsed = taskSchema.safeParse(raw);
    if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    const error = validateTaskInput(user.id, parsed.data);
    if (error) return error;
    const result = compileRecipe(user.id, parsed.data, user.isAdmin);
    if (typeof result === 'string') return result;
    compiled.push(normalizeTask(result, user.isAdmin));
  }
  const tasks = compiled.map((item) => insertTask(user.id, item, origin));
  if (tasks.length) kickScheduler();
  return tasks;
}

/**
 * 取消一个任务：生成中的先通知算子取消；排队、暂停、生成中都标记为已取消并推送。
 * 已经结束的任务不动。返回是否真的取消了。
 */
export async function cancelTaskById(id: string): Promise<boolean> {
  const row = db.prepare('SELECT status, provider_job_id, operator_id FROM tasks WHERE id = ?').get(id) as Row | undefined;
  if (!row || !['queued', 'paused', 'running'].includes(String(row.status))) return false;
  if (row.status === 'running' && row.provider_job_id) {
    const { getAdapter } = await import('../providers/index.ts');
    await getAdapter((row.operator_id as string | null) ?? null)
      ?.cancel(String(row.provider_job_id))
      .catch(() => undefined);
  }
  db.prepare("UPDATE tasks SET status = 'canceled', manual_kick = 0, provider_job_id = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'paused', 'running')").run(now(), now(), id);
  const { emitTask, notifyTaskSettled } = await import('../scheduler.ts');
  emitTask(id);
  notifyTaskSettled(id);
  return true;
}
