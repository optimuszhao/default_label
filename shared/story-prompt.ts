// 故事镜头的提示词构建器（STY-03），前端预览和服务端批量生成共用一套。
// 按段拼装：画风 → 地点 → 景别运镜 → 画面描述 → 角色（外貌 + 服装）→ 道具 → 追加内容（→ 台词，仅视频）。
// 超过 600 字时按优先级截断：先去台词，再去道具、画风、地点，再压缩角色，画面描述最后才动。
import { clampDuration, resolveSize, type Capabilities } from './operator.ts';
import type { Character, GenParams, Scene, Shot, StoryData, StoryElement, TaskType } from './types.ts';

export const DEFAULT_KEYFRAME_NEGATIVE = '模糊，低质量，畸形，多余的手指，文字水印';
export const DEFAULT_VIDEO_NEGATIVE = '画面闪烁，人物变形，低质量';
export const PROMPT_LIMIT = 600;

export type SegmentKind = 'style' | 'location' | 'camera' | 'description' | 'character' | 'prop' | 'extra' | 'dialogue' | 'override';

export interface PromptSegment {
  kind: SegmentKind;
  /** 界面上分段着色时显示的名字 */
  label: string;
  text: string;
}

export interface BuiltPrompt {
  segments: PromptSegment[];
  prompt: string;
  negative: string;
  /** 被截断掉的段 */
  dropped: SegmentKind[];
  seed: number | null;
}

/** 截断时先去掉的放前面 */
const DROP_ORDER: SegmentKind[] = ['dialogue', 'prop', 'style', 'location', 'extra', 'character', 'camera'];

export const SEGMENT_LABEL: Record<SegmentKind, string> = {
  style: '画风',
  location: '地点',
  camera: '景别运镜',
  description: '画面',
  character: '角色',
  prop: '道具',
  extra: '追加',
  dialogue: '台词',
  override: '手写提示词',
};

/** 描述里的 @名字 → 去掉 @ 交给模型 */
export function stripMentions(text: string): string {
  return text.replace(/@([^\s@，。、,.!！?？；;：:]+)/g, '$1');
}

/** 找出描述里 @ 到的角色和设定（按名字或别名匹配） */
export function findMentions(text: string, data: StoryData): { characterIds: string[]; elementIds: string[] } {
  const names = [...text.matchAll(/@([^\s@，。、,.!！?？；;：:]+)/g)].map((m) => m[1]);
  const characterIds: string[] = [];
  const elementIds: string[] = [];
  const matches = (name: string, item: { name: string; aliases?: string[] }) => item.name === name || (item.aliases ?? []).includes(name) || name.startsWith(item.name);
  for (const name of names) {
    const character = data.characters.find((c) => matches(name, c));
    if (character) {
      if (!characterIds.includes(character.id)) characterIds.push(character.id);
      continue;
    }
    const element = (data.elements ?? []).find((e) => matches(name, e));
    if (element && !elementIds.includes(element.id)) elementIds.push(element.id);
  }
  return { characterIds, elementIds };
}

function characterLine(character: Character, outfitId?: string): string {
  const outfit = character.outfits?.find((o) => o.id === outfitId) ?? null;
  const looks = [character.appearance, outfit?.snippet].filter(Boolean).join('，');
  return looks ? `${character.name}（${looks}）` : '';
}

function elementsOf(data: StoryData, ids: string[] | undefined, kind: StoryElement['kind']): StoryElement[] {
  return (ids ?? []).map((id) => (data.elements ?? []).find((e) => e.id === id)).filter((e): e is StoryElement => Boolean(e && e.kind === kind));
}

export interface BuildOptions {
  purpose: 'keyframe' | 'video';
  /** 每个角色穿哪套服装（角色 id → 服装 id） */
  outfits?: Record<string, string>;
  limit?: number;
}

export function buildShotPrompt(data: StoryData, scene: Scene, shot: Shot, options: BuildOptions): BuiltPrompt {
  const video = options.purpose === 'video';
  const characters = shot.characterIds.map((id) => data.characters.find((c) => c.id === id)).filter((c): c is Character => Boolean(c));
  const negative = [
    data.negativePrompt?.trim() || (video ? DEFAULT_VIDEO_NEGATIVE : DEFAULT_KEYFRAME_NEGATIVE),
    ...characters.map((c) => c.negative ?? ''),
    ...elementsOf(data, shot.elementIds, 'prop').map((e) => e.negative ?? ''),
    shot.negative ?? '',
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('，');
  const seed = shot.seed ?? characters.find((c) => c.seed != null)?.seed ?? data.defaultSeed ?? null;

  if (shot.promptOverride?.trim()) {
    const text = shot.promptOverride.trim();
    return { segments: [{ kind: 'override', label: SEGMENT_LABEL.override, text }], prompt: text, negative, dropped: [], seed };
  }

  const segments: PromptSegment[] = [];
  const push = (kind: SegmentKind, text: string) => {
    const clean = text.trim();
    if (clean) segments.push({ kind, label: SEGMENT_LABEL[kind], text: clean });
  };
  const styles = [data.visualStyle, ...elementsOf(data, shot.elementIds, 'style').map((e) => e.snippet)].filter(Boolean);
  if (!video) push('style', styles.length ? `${styles.join('，')}。` : '');
  const location = scene.locationId ? (data.elements ?? []).find((e) => e.id === scene.locationId) : null;
  const locations = [location?.snippet || scene.location, ...elementsOf(data, shot.elementIds, 'location').map((e) => e.snippet || e.name), scene.time].filter(Boolean);
  push('location', locations.length ? `${[...new Set(locations)].join('，')}。` : '');
  push('camera', video ? `${shot.cameraMove === '固定' || !shot.cameraMove ? '固定机位' : `${shot.cameraMove}镜头`}，${shot.shotSize}。` : `${shot.shotSize}。`);
  push('description', stripMentions(shot.description) ? `${stripMentions(shot.description).replace(/[。.]$/, '')}。` : '');
  const people = characters.map((c) => characterLine(c, options.outfits?.[c.id])).filter(Boolean);
  push('character', people.length ? `出镜角色：${people.join('；')}。` : '');
  const props = elementsOf(data, shot.elementIds, 'prop');
  push('prop', props.length ? `道具：${props.map((p) => (p.snippet ? `${p.name}（${p.snippet}）` : p.name)).join('；')}。` : '');
  push('extra', shot.extraPrompt ?? '');
  if (video) {
    push('style', styles.length ? `风格：${styles.join('，')}。` : '');
    const lines = shot.dialogueIds.map((id) => scene.dialogue.find((d) => d.id === id)).filter((d) => d?.text);
    push(
      'dialogue',
      lines.length
        ? `人物台词：${lines
            .map((line) => `${data.characters.find((c) => c.id === line!.characterId)?.name ?? '旁白'}${line!.emotion ? `（${line!.emotion}）` : ''}：“${line!.text}”`)
            .join(' ')}`
        : '',
    );
  }

  const limit = options.limit ?? PROMPT_LIMIT;
  const dropped: SegmentKind[] = [];
  const total = () => segments.reduce((n, s) => n + s.text.length, 0);
  for (const kind of DROP_ORDER) {
    if (total() <= limit) break;
    const index = segments.findIndex((s) => s.kind === kind);
    if (index < 0) continue;
    if (kind === 'character') {
      // 角色只保留名字和前 30 个字的外貌
      segments[index] = { ...segments[index], text: `出镜角色：${characters.map((c) => `${c.name}（${c.appearance.slice(0, 30)}）`).join('；')}。` };
      if (total() <= limit) break;
    }
    segments.splice(index, 1);
    dropped.push(kind);
  }
  if (total() > limit) {
    const index = segments.findIndex((s) => s.kind === 'description');
    if (index >= 0) segments[index] = { ...segments[index], text: segments[index].text.slice(0, Math.max(50, limit - (total() - segments[index].text.length))) };
  }
  return { segments, prompt: segments.map((s) => s.text).join(''), negative, dropped, seed };
}

/** 定妆照：半身、纯色背景、正面 */
export function portraitPrompt(data: StoryData, character: Character): string {
  return `${data.visualStyle}。角色定妆照，半身像，纯色背景，正面，清晰面部特征。${character.name}：${character.appearance}`;
}

export interface ShotTaskInput {
  type: TaskType;
  title: string;
  prompt: string;
  negativePrompt: string;
  params: GenParams;
  inputs: { firstFrameAssetId?: string | null };
  link: { storyId: string; shotId: string; purpose: 'keyframe' | 'video' };
}

export function shotLabel(scene: Scene, shot: Shot): string {
  const index = scene.shots.findIndex((s) => s.id === shot.id) + 1;
  return `${scene.title} · #${shot.code || String(index).padStart(2, '0')}`;
}

/** 镜头 → 生成任务（关键帧走文生图；视频有首帧时走图生视频） */
export function buildShotTask(
  data: StoryData,
  scene: Scene,
  shot: Shot,
  purpose: 'keyframe' | 'video',
  context: { storyId: string; caps: Capabilities; firstFrameAssetId?: string | null; resolution?: string },
): ShotTaskInput {
  const built = buildShotPrompt(data, scene, shot, { purpose });
  const label = shotLabel(scene, shot);
  if (purpose === 'keyframe') {
    const resolution = context.resolution ?? '1k';
    return {
      type: 't2i',
      title: `${label} 关键帧`,
      prompt: built.prompt,
      negativePrompt: built.negative,
      params: { aspectRatio: data.aspectRatio, resolution, ...resolveSize(context.caps.image, data.aspectRatio, resolution), count: 1, seed: built.seed },
      inputs: {},
      link: { storyId: context.storyId, shotId: shot.id, purpose },
    };
  }
  const resolution = context.resolution ?? '720p';
  const duration = clampDuration(context.caps.video, shot.duration || 5);
  return {
    type: context.firstFrameAssetId ? 'i2v' : 't2v',
    title: `${label} 视频`,
    prompt: built.prompt,
    negativePrompt: built.negative,
    params: { aspectRatio: data.aspectRatio, resolution, ...resolveSize(context.caps.video, data.aspectRatio, resolution), count: 1, seed: built.seed, duration, fps: 24 },
    inputs: { firstFrameAssetId: context.firstFrameAssetId ?? null },
    link: { storyId: context.storyId, shotId: shot.id, purpose },
  };
}

/** 预估 GPU 耗时（秒）：图片约 30 秒一张，视频按时长折算（对方 5090 实测 5 秒视频约 20 分钟） */
export function estimateSeconds(type: TaskType, duration = 5): number {
  if (type === 't2i' || type === 'i2i') return 30;
  return Math.round(240 * Math.max(4, duration));
}
