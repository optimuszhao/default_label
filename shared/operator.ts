// 算子能力声明 v0：每个算子说明自己支持哪些控件和参数范围，
// 前端据此只显示真正起作用的选项，服务端据此规整参数。
// （M3 起扩展为完整的能力声明与模型目录，见 docs/ROADMAP.md 附录 A）

export interface SizePreset {
  aspectRatio: string;
  width: number;
  height: number;
}

export interface ResolutionOption {
  value: string;
  label: string;
  /** 短边像素 */
  short: number;
}

export interface ModeCapability {
  /** 图生图最多几张参考图（0 = 不支持图生图） */
  maxReferences: number;
  /** 视频：是否支持首帧 / 尾帧 */
  firstFrame: boolean;
  lastFrame: boolean;
  strength: boolean;
  cfg: boolean;
  steps: boolean;
  negativePrompt: boolean;
  /** 一次最多出几张 */
  maxCount: number;
  /** 可选时长（秒），只对视频有意义 */
  durations: number[];
  /** 可选分辨率档位；为空表示尺寸由算子固定（见 sizes） */
  resolutions: ResolutionOption[];
  /** 算子原生尺寸：按比例给出固定宽高，优先于 resolutions */
  sizes: SizePreset[];
  /** 宽高需要对齐到的倍数 */
  sizeStep: number;
  /** 展示给用户的输出说明，例如“输出自动 2x 超分” */
  note?: string;
}

export interface Capabilities {
  operator: string;
  image: ModeCapability;
  video: ModeCapability;
}

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;

export const IMAGE_RESOLUTIONS: ResolutionOption[] = [
  { value: '1k', label: '标准 1K', short: 1024 },
  { value: '2k', label: '高清 2K', short: 1536 },
];

export const VIDEO_RESOLUTIONS: ResolutionOption[] = [
  { value: '480p', label: '480P', short: 480 },
  { value: '720p', label: '720P', short: 720 },
  { value: '1080p', label: '1080P', short: 1080 },
];

/** 通用默认能力：mock 和按 docs/API_CONTRACT.md 实现的 http 算子 */
export const DEFAULT_CAPABILITIES: Capabilities = {
  operator: 'default',
  image: {
    maxReferences: 4,
    firstFrame: false,
    lastFrame: false,
    strength: true,
    cfg: true,
    steps: true,
    negativePrompt: true,
    maxCount: 4,
    durations: [],
    resolutions: IMAGE_RESOLUTIONS,
    sizes: [],
    sizeStep: 16,
  },
  video: {
    maxReferences: 0,
    firstFrame: true,
    lastFrame: true,
    strength: false,
    cfg: true,
    steps: true,
    negativePrompt: true,
    maxCount: 1,
    durations: [4, 5, 8, 10, 15],
    resolutions: VIDEO_RESOLUTIONS,
    sizes: [],
    sizeStep: 16,
  },
};

function align(value: number, step: number): number {
  return Math.max(step * 4, Math.round(value / step) * step);
}

/** 根据比例和分辨率档位算出实际提交的宽高 */
export function resolveSize(cap: ModeCapability, aspectRatio: string, resolution: string): { width: number; height: number } {
  const fixed = cap.sizes.find((size) => size.aspectRatio === aspectRatio) ?? cap.sizes[0];
  if (fixed) return { width: fixed.width, height: fixed.height };
  const short = cap.resolutions.find((item) => item.value === resolution)?.short ?? cap.resolutions[0]?.short ?? 1024;
  const [w, h] = aspectRatio.split(':').map(Number);
  if (!w || !h) return { width: align(short, cap.sizeStep), height: align(short, cap.sizeStep) };
  return w >= h
    ? { width: align((short * w) / h, cap.sizeStep), height: align(short, cap.sizeStep) }
    : { width: align(short, cap.sizeStep), height: align((short * h) / w, cap.sizeStep) };
}

/** 把时长收进算子支持的范围 */
export function clampDuration(cap: ModeCapability, duration: number): number {
  if (!cap.durations.length) return duration;
  const min = Math.min(...cap.durations);
  const max = Math.max(...cap.durations);
  return Math.min(max, Math.max(min, Math.round(duration)));
}

export function maxDuration(cap: ModeCapability): number {
  return cap.durations.length ? Math.max(...cap.durations) : Infinity;
}
