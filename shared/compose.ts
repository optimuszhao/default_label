// 提示词编译器：把配方（模板 + 变量 + 预设 + 用户正文 + 参数修改）编成最终提交给算子的
// 提示词、反向词和参数。前端用它实时预览，服务端用它生成任务——两边结果一致，以服务端为准。
import { clampDuration, resolveSize, type Capabilities } from './operator.ts';
import type { Preset, PresetKind, PromptTemplate, Recipe } from './presets.ts';
import type { GenParams } from './types.ts';

export const COMPOSER_VERSION = 1;
/** 正向提示词的长度上限（字符） */
export const MAX_PROMPT_LENGTH = 1500;

/** suffix 片段的排序：构图 → 镜头 → 光线 → 色调 → 风格 */
const SUFFIX_ORDER: PresetKind[] = ['shot', 'angle', 'layout', 'camera', 'speed', 'lighting', 'tone', 'style', 'scene', 'negative'];

const VAR_PATTERN = /\{([^{}\s]{1,16})\}/g;

/** 填模板变量：用户填写 → 默认值 → 空串；{{ 和 }} 是字面量的花括号 */
export function fillVariables(body: string, template: Pick<PromptTemplate, 'variables'> | null, vars: Record<string, string> = {}): string {
  const OPEN = '\u0000';
  const CLOSE = '\u0001';
  const escaped = body.replaceAll('{{', OPEN).replaceAll('}}', CLOSE);
  const filled = escaped.replace(VAR_PATTERN, (_, key: string) => {
    const value = vars[key]?.trim();
    if (value) return value;
    return template?.variables.find((variable) => variable.key === key)?.default?.trim() ?? '';
  });
  return cleanPunctuation(filled.replaceAll(OPEN, '{').replaceAll(CLOSE, '}'));
}

/** 变量名列表（按出现顺序去重） */
export function templateVariables(body: string): string[] {
  const keys: string[] = [];
  for (const match of body.replaceAll('{{', '').replaceAll('}}', '').matchAll(VAR_PATTERN)) {
    if (!keys.includes(match[1])) keys.push(match[1]);
  }
  return keys;
}

/** 清理变量为空后留下的连续标点和首尾标点 */
export function cleanPunctuation(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/([，,、；;。])\s*(?=[，,、；;。])/g, '')
    .replace(/^[\s，,、；;。]+/, '')
    .replace(/[\s，,、；;]+$/, '')
    .replace(/\s*([，,、；;。])\s*/g, '$1')
    .trim();
}

/** 按短句去重：逗号、分号、句号切开，去掉重复的短句 */
export function dedupeClauses(text: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of text.split(/[，,；;。\n]/)) {
    const part = raw.trim();
    if (!part) continue;
    const key = part.toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }
  return parts.join('，');
}

/** 选中的预设：只保留适用于当前模式的；同一互斥组只保留最后选中的 */
export function resolvePresets(slugs: string[], catalog: Map<string, Preset>, mode: Recipe['mode']) {
  const skipped: Preset[] = [];
  const byGroup = new Map<string, Preset>();
  const multi: Preset[] = [];
  for (const slug of slugs) {
    const preset = catalog.get(slug);
    if (!preset || !preset.enabled) continue;
    if (preset.applies !== 'both' && preset.applies !== mode) {
      skipped.push(preset);
      continue;
    }
    if (preset.group) {
      byGroup.delete(preset.group); // 保持“最后选中”的顺序
      byGroup.set(preset.group, preset);
    } else if (!multi.includes(preset)) {
      multi.push(preset);
    }
  }
  return { presets: [...byGroup.values(), ...multi], skipped };
}

/** 互斥组里切换：选中一个预设时，去掉同组的其他预设 */
export function togglePreset(selected: string[], slug: string, catalog: Map<string, Preset>): string[] {
  if (selected.includes(slug)) return selected.filter((item) => item !== slug);
  const preset = catalog.get(slug);
  const group = preset?.group;
  const kept = group ? selected.filter((item) => catalog.get(item)?.group !== group) : selected;
  return [...kept, slug];
}

export interface ComposeInput {
  recipe: Recipe;
  template?: PromptTemplate | null;
  catalog: Map<string, Preset>;
  caps: Capabilities;
}

export interface ComposeResult {
  prompt: string;
  negativePrompt: string;
  params: GenParams;
  /** 实际生效的预设（去掉了不适用和被同组替换的） */
  presets: string[];
  warnings: string[];
}

function joinParts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('，');
}

export function compose({ recipe, template, catalog, caps }: ComposeInput): ComposeResult {
  const warnings: string[] = [];
  const mode = recipe.mode;
  const cap = mode === 'video' ? caps.video : caps.image;

  // 1. 正文：模板填变量 + 补充描述
  const text = recipe.text.trim();
  const body = template ? joinParts([fillVariables(template.body, template, recipe.vars), text]) : text;
  if (template && template.mode !== mode) warnings.push(`模板「${template.name}」是${template.mode === 'video' ? '视频' : '图片'}模板`);

  // 2. 预设
  const slugs = [...(template?.presets ?? []), ...recipe.presets];
  const { presets, skipped } = resolvePresets(slugs, catalog, mode);
  for (const preset of skipped) warnings.push(`「${preset.name}」只适用于${preset.applies === 'video' ? '视频' : '图片'}，已忽略`);

  // 3. 拼接：prefix → 正文 → suffix（按种类排序）
  const prefix = presets.filter((p) => p.position === 'prefix' && p.prompt).map((p) => p.prompt);
  const suffix = presets
    .filter((p) => p.position === 'suffix' && p.prompt)
    .sort((a, b) => SUFFIX_ORDER.indexOf(a.kind) - SUFFIX_ORDER.indexOf(b.kind))
    .map((p) => p.prompt);

  // 4. 反向词：用户 + 模板 + 预设；算子不支持时把预设的 fallback 改成正向约束
  const negatives = [recipe.negative, template?.negative ?? '', ...presets.map((p) => p.negative ?? '')];
  let negativePrompt = dedupeClauses(negatives.filter(Boolean).join('，'));
  const fallbacks: string[] = [];
  if (!cap.negativePrompt && negativePrompt) {
    for (const preset of presets) if (preset.negative && preset.fallbackPrompt) fallbacks.push(preset.fallbackPrompt);
    warnings.push(fallbacks.length ? '当前算子不支持反向提示词，已改为正向约束' : '当前算子不支持反向提示词，已忽略');
    negativePrompt = '';
  }

  // 5. 去重，超长时从末尾的修饰片段开始删
  const head = dedupeClauses(joinParts([...prefix, body]));
  let tail = dedupeClauses(joinParts([...suffix, ...fallbacks]));
  let prompt = dedupeClauses(joinParts([head, tail]));
  if (prompt.length > MAX_PROMPT_LENGTH) {
    const pieces = tail.split('，');
    while (pieces.length && joinParts([head, pieces.join('，')]).length > MAX_PROMPT_LENGTH) pieces.pop();
    tail = pieces.join('，');
    prompt = joinParts([head, tail]);
    if (prompt.length > MAX_PROMPT_LENGTH) prompt = prompt.slice(0, MAX_PROMPT_LENGTH);
    warnings.push(`提示词超过 ${MAX_PROMPT_LENGTH} 字，已删掉末尾的修饰片段`);
  }

  // 6. 参数：能力默认 → 预设推荐 → 模板 → 用户明确修改
  const merged: { aspectRatio: string; resolution: string; count: number; duration: number } = {
    aspectRatio: '16:9',
    resolution: cap.resolutions[0]?.value ?? (mode === 'video' ? '720p' : '1k'),
    count: 1,
    duration: 5,
  };
  for (const preset of presets) {
    if (preset.params?.aspectRatio) merged.aspectRatio = preset.params.aspectRatio;
    if (preset.params?.duration) merged.duration = preset.params.duration;
  }
  if (template?.params.aspectRatio) merged.aspectRatio = template.params.aspectRatio;
  if (template?.params.duration) merged.duration = template.params.duration;
  if (template?.params.count) merged.count = template.params.count;
  const o = recipe.overrides;
  if (o.aspectRatio) merged.aspectRatio = o.aspectRatio;
  if (o.resolution) merged.resolution = o.resolution;
  if (o.count) merged.count = o.count;
  if (o.duration) merged.duration = o.duration;

  const size = resolveSize(cap, merged.aspectRatio, merged.resolution);
  const params: GenParams = {
    aspectRatio: merged.aspectRatio,
    resolution: merged.resolution,
    width: size.width,
    height: size.height,
    count: mode === 'video' ? 1 : Math.min(Math.max(merged.count, 1), cap.maxCount),
    seed: o.seed ?? null,
  };
  if (cap.steps && o.steps) params.steps = o.steps;
  if (cap.strength && o.strength != null) params.strength = o.strength;
  if (mode === 'video') {
    params.duration = clampDuration(cap, merged.duration);
    if (params.duration !== merged.duration) warnings.push(`时长已调整为 ${params.duration} 秒（算子支持 ${cap.durations.join('/')} 秒）`);
    if (o.cameraMotion && o.cameraMotion !== '自动') params.cameraMotion = o.cameraMotion;
  }
  if (merged.count > cap.maxCount && mode === 'image') warnings.push(`一次最多 ${cap.maxCount} 张`);

  return { prompt, negativePrompt, params, presets: presets.map((p) => p.slug), warnings };
}

/** 空配方 */
export function emptyRecipe(mode: Recipe['mode']): Recipe {
  return { version: 1, mode, text: '', templateId: null, vars: {}, presets: [], negative: '', overrides: {}, parentAssetId: null };
}
