// 首批官方工作流（WF-05）：W1 四选一出视频、W2 角色定妆照、W4 长镜头接力
import type { WorkflowDef } from './types.ts';

const str = (value: unknown, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);

export const w1: WorkflowDef = {
  id: 'w1-pick-to-video',
  title: '四选一出视频',
  description: '先出 4 张候选图，你挑最满意的一张做首帧，再生成视频。无人值守时自动选第一张。',
  estimate: '4 张图约 4–8 分钟，再加 1 段视频约 20–30 分钟',
  inputs: [
    { key: 'idea', label: '画面描述', type: 'text', multiline: true, required: true, placeholder: '雨夜霓虹街头，撑伞的少女回眸' },
    { key: 'style', label: '风格', type: 'preset', default: 'style-cinematic' },
    { key: 'motion', label: '动作与运镜', type: 'text', default: '人物缓缓转身看向镜头，镜头缓慢推进' },
    { key: 'aspectRatio', label: '比例', type: 'select', default: '16:9', options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] },
    { key: 'duration', label: '视频时长（秒）', type: 'select', default: 5, options: [5, 8, 10] },
  ],
  steps: [
    {
      id: 'kf',
      kind: 'generate',
      label: '生成 4 张候选',
      forEach: { over: () => [0, 1, 2, 3], mode: 'parallel' },
      task: (c) => ({
        type: 't2i',
        prompt: str(c.inputs.idea),
        presets: [str(c.inputs.style), 'neg-quality'].filter(Boolean),
        params: { aspectRatio: str(c.inputs.aspectRatio, '16:9'), resolution: '1k' },
      }),
    },
    { id: 'pick', kind: 'select', label: '挑一张做首帧', from: 'kf', min: 1, max: 1, auto: 'first', hint: '选构图和人物最满意的一张，视频会从这张开始动' },
    {
      id: 'vid',
      kind: 'generate',
      label: '图生视频',
      task: (c) => ({
        type: 'i2v',
        prompt: `${str(c.inputs.idea)}。${str(c.inputs.motion)}`,
        presets: [str(c.inputs.style), 'neg-flicker'].filter(Boolean),
        params: { aspectRatio: str(c.inputs.aspectRatio, '16:9'), resolution: '720p', duration: Number(c.inputs.duration) || 5 },
        inputs: { firstFrame: c.steps.pick.assets[0] },
      }),
    },
  ],
  outputs: ['vid', 'pick'],
};

export const w2: WorkflowDef = {
  id: 'w2-character-portrait',
  title: '角色定妆照',
  description: '半身、纯色背景、正面出 4 张定妆照，挑一张；可以直接写回故事里角色的主参考图。',
  estimate: '约 4–8 分钟',
  inputs: [
    { key: 'character', label: '故事里的角色（可选）', type: 'character', hint: '选了角色会用它的外貌描述，并把挑中的图写回它的主参考图' },
    { key: 'name', label: '角色名', type: 'text', placeholder: '林昔' },
    { key: 'appearance', label: '外貌描述', type: 'text', multiline: true, placeholder: '17 岁少女，齐肩黑色短发，琥珀色眼睛，米色工装外套和红色围巾' },
    { key: 'style', label: '风格', type: 'preset', default: 'style-cinematic' },
  ],
  steps: [
    {
      id: 'shots',
      kind: 'generate',
      label: '生成 4 张定妆照',
      forEach: { over: () => [0, 1, 2, 3], mode: 'parallel' },
      task: (c) => ({
        type: 't2i',
        title: `定妆照 · ${str(c.inputs.name, '角色')}`,
        prompt: `角色定妆照，半身像，纯色背景，正面，清晰面部特征。${str(c.inputs.name)}：${str(c.inputs.appearance)}`,
        presets: [str(c.inputs.style), 'neg-quality', 'neg-crowd'].filter(Boolean),
        params: { aspectRatio: '3:4', resolution: '1k' },
      }),
    },
    { id: 'pick', kind: 'select', label: '挑一张定妆照', from: 'shots', min: 1, max: 1, auto: 'first' },
    {
      id: 'apply',
      kind: 'local',
      label: '写回角色主参考图',
      op: 'set_character_ref',
      source: (c) => c.steps.pick.assets,
      optional: (c) => Boolean(c.inputs.character),
    },
  ],
  outputs: ['pick'],
};

export const w4: WorkflowDef = {
  id: 'w4-relay',
  title: '长镜头接力',
  description: '从一张起始画面出发，逐段生成视频，每段用上一段的尾帧做首帧，最后拼成一个连贯的长镜头。',
  estimate: '每段约 20–30 分钟，按段数累加',
  inputs: [
    { key: 'start', label: '起始画面', type: 'image', required: true },
    {
      key: 'beats',
      label: '分段动作（每行一段，2–4 段）',
      type: 'lines',
      min: 2,
      max: 4,
      default: ['少女推开木门走进花园', '她弯腰拾起地上的信封', '她抬头望向远处的钟楼，镜头缓缓升起'],
    },
    { key: 'duration', label: '每段时长（秒）', type: 'select', default: 5, options: [5, 8, 10] },
  ],
  steps: [
    {
      id: 'seg',
      kind: 'generate',
      label: '逐段生成',
      forEach: { over: (c) => (Array.isArray(c.inputs.beats) ? c.inputs.beats : []), mode: 'sequential' },
      task: (c, item, i, prev) => ({
        type: 'i2v',
        title: `长镜头接力 · 第 ${i + 1} 段`,
        prompt: String(item),
        presets: ['neg-flicker'],
        params: { duration: Number(c.inputs.duration) || 5, resolution: '720p' },
        inputs: { firstFrame: i === 0 ? str(c.inputs.start) : { lastFrameOf: prev!.assets[i - 1] } },
      }),
    },
    { id: 'join', kind: 'local', label: '拼接成片', op: 'concat_videos', source: (c) => c.steps.seg.assets },
  ],
  outputs: ['join', 'seg'],
};

interface PlannedShot {
  description: string;
  motion: string;
  duration?: number;
}

const planned = (c: { steps: Record<string, { output?: unknown }> }): PlannedShot[] => {
  const output = c.steps.plan?.output as { shots?: PlannedShot[] } | undefined;
  return Array.isArray(output?.shots) ? output.shots.slice(0, 8) : [];
};

export const w5: WorkflowDef = {
  id: 'w5-one-line-film',
  title: '一句话短片',
  description: 'AI 把一句话拆成几个镜头，逐个出画面再动起来，最后拼成一个短片。全程不用挑选。',
  estimate: '每个镜头约 20–30 分钟（视频），按镜头数累加',
  inputs: [
    { key: 'idea', label: '一句话', type: 'text', multiline: true, required: true, placeholder: '一只橘猫在雨夜的屋顶上等主人回家' },
    { key: 'count', label: '镜头数', type: 'select', default: 3, options: [2, 3, 4, 5, 6] },
    { key: 'style', label: '风格', type: 'preset', default: 'style-cinematic' },
    { key: 'aspectRatio', label: '比例', type: 'select', default: '16:9', options: ['16:9', '9:16', '1:1'] },
  ],
  steps: [
    { id: 'plan', kind: 'llm', label: 'AI 拆分镜头', assist: 'split_shots', input: (c) => ({ idea: str(c.inputs.idea), count: Number(c.inputs.count) || 3 }) },
    {
      id: 'frames',
      kind: 'generate',
      label: '每个镜头出一张画面',
      forEach: { over: (c) => planned(c), mode: 'parallel' },
      task: (c, item) => ({
        type: 't2i',
        prompt: (item as PlannedShot).description,
        presets: [str(c.inputs.style), 'neg-quality'].filter(Boolean),
        params: { aspectRatio: str(c.inputs.aspectRatio, '16:9'), resolution: '1k' },
      }),
    },
    {
      id: 'clips',
      kind: 'generate',
      label: '每个镜头动起来',
      forEach: { over: (c) => c.steps.frames.assets, mode: 'parallel' },
      task: (c, item, i) => ({
        type: 'i2v',
        prompt: `${planned(c)[i]?.description ?? ''}。${planned(c)[i]?.motion ?? ''}`,
        presets: [str(c.inputs.style), 'neg-flicker'].filter(Boolean),
        params: { aspectRatio: str(c.inputs.aspectRatio, '16:9'), resolution: '720p', duration: planned(c)[i]?.duration ?? 5 },
        inputs: { firstFrame: String(item) },
      }),
    },
    { id: 'join', kind: 'local', label: '拼接成片', op: 'concat_videos', source: (c) => c.steps.clips.assets },
  ],
  outputs: ['join', 'clips'],
};

export const WORKFLOWS: WorkflowDef[] = [w1, w2, w4, w5];

/**
 * 校验工作流定义（启动时和单测里都会跑）：step id 唯一；select 引用的步骤存在且在它之前；
 * 首帧和起始画面必须是图片输入；接力只能用在串行的图生视频上。
 */
export function validateWorkflow(def: WorkflowDef): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const step of def.steps) {
    if (seen.has(step.id)) errors.push(`${def.id}：步骤 id 重复 ${step.id}`);
    if (step.kind === 'select' && !seen.has(step.from)) errors.push(`${def.id}：${step.id} 引用的步骤 ${step.from} 不存在或在它之后`);
    seen.add(step.id);
  }
  for (const input of def.inputs) if (input.type === 'image' && input.default != null) errors.push(`${def.id}：图片输入不能有默认值`);
  for (const output of def.outputs) if (!seen.has(output)) errors.push(`${def.id}：输出引用的步骤 ${output} 不存在`);
  // 试跑一遍任务描述：接力（lastFrameOf）只允许出现在串行的图生视频里
  for (const step of def.steps) {
    if (step.kind !== 'generate') continue;
    const fake = { inputs: Object.fromEntries(def.inputs.map((i) => [i.key, i.default ?? (i.type === 'lines' ? ['a', 'b'] : 'x')])), steps: {}, userId: '' };
    const prev = { status: 'done' as const, assets: ['a_prev'], taskIds: [] };
    try {
      const steps = new Proxy({}, { get: () => ({ status: 'done', assets: ['a_x'], taskIds: [] }) });
      const spec = step.task({ ...fake, steps }, 'x', 1, prev);
      const relay = typeof spec.inputs?.firstFrame === 'object' && spec.inputs?.firstFrame !== null;
      if (relay && (step.forEach?.mode !== 'sequential' || spec.type !== 'i2v')) errors.push(`${def.id}：${step.id} 接力只能用在串行的图生视频上`);
      if (spec.inputs?.firstFrame && spec.type !== 'i2v') errors.push(`${def.id}：${step.id} 有首帧却不是图生视频`);
    } catch (error) {
      errors.push(`${def.id}：${step.id} 任务描述出错：${(error as Error).message}`);
    }
  }
  return errors;
}
