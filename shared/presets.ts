// 预设、提示词模板、配方的数据结构（前后端共用）

/** 预设种类。同一互斥组（group）里只保留最后选中的一个 */
export type PresetKind =
  | 'style' // 风格
  | 'lighting' // 光线
  | 'shot' // 景别
  | 'angle' // 角度
  | 'layout' // 构图
  | 'tone' // 色调
  | 'camera' // 运镜（视频）
  | 'speed' // 速度（视频）
  | 'negative' // 负向（可多选）
  | 'scene'; // 场景尺寸

export type MediaMode = 'image' | 'video';

export interface Preset {
  slug: string;
  kind: PresetKind;
  name: string;
  /** 互斥组；空字符串表示可以和同类多选（负向） */
  group: string;
  /** prefix 放在正文前，suffix 放在正文后 */
  position: 'prefix' | 'suffix';
  /** 适用模式 */
  applies: MediaMode | 'both';
  /** 拼进正向提示词的片段 */
  prompt: string;
  /** 拼进反向提示词的片段 */
  negative?: string;
  /** 算子不支持反向词时，改为追加到正向的约束 */
  fallbackPrompt?: string;
  /** 推荐参数，例如场景尺寸预设给出比例 */
  params?: { aspectRatio?: string; duration?: number };
  /** 封面资产 id */
  cover?: string | null;
  /** 一句话说明，面板里显示 */
  hint?: string;
  sort: number;
  enabled: boolean;
}

export interface TemplateVariable {
  key: string;
  label: string;
  default?: string;
  placeholder?: string;
  /** 可选值（显示为快捷按钮） */
  options?: string[];
}

export interface PromptTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  mode: MediaMode;
  /** 带 {变量} 的正文 */
  body: string;
  variables: TemplateVariable[];
  negative: string;
  /** 套用时一并选中的预设 slug */
  presets: string[];
  params: { aspectRatio?: string; duration?: number; count?: number };
  requiresReference: boolean;
  featured: boolean;
  cover?: string | null;
  sort: number;
  enabled: boolean;
  /** 列表接口附带：热门分、当前用户是否收藏、使用次数 */
  hot?: number;
  favorite?: boolean;
  uses?: number;
}

/**
 * 配方：用户在创作台里的全部选择。和编译后的提示词一起记在任务上，
 * “改参数重跑”“再来一次”据此完整还原。
 */
export interface Recipe {
  version: number;
  mode: MediaMode;
  /** 用户自己写的正文（套用模板时是“补充描述”） */
  text: string;
  templateId?: string | null;
  vars?: Record<string, string>;
  presets: string[];
  /** 用户写的反向词 */
  negative: string;
  /** 用户明确改过的参数 */
  overrides: {
    aspectRatio?: string;
    resolution?: string;
    count?: number;
    duration?: number;
    seed?: number | null;
    steps?: number;
    /** 图生图重绘强度 0–1：越小越贴近参考图 */
    strength?: number;
    cameraMotion?: string;
  };
  /** 派生来源（变体、以此为参考、图转视频） */
  parentAssetId?: string | null;
}

export const RECIPE_VERSION = 1;

export const PRESET_KIND_LABEL: Record<PresetKind, string> = {
  style: '风格',
  lighting: '光线',
  shot: '景别',
  angle: '角度',
  layout: '构图',
  tone: '色调',
  camera: '运镜',
  speed: '速度',
  negative: '负向',
  scene: '尺寸',
};

export interface UserPrompt {
  id: string;
  name: string;
  body: string;
  mode: MediaMode;
  createdAt: number;
}
