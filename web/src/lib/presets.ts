import type { GenParams } from '../../../shared/types.ts';

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;

export const IMAGE_RESOLUTIONS = [
  { value: '1k', label: '标准 1K', short: 1024 },
  { value: '2k', label: '高清 2K', short: 1536 },
] as const;

export const VIDEO_RESOLUTIONS = [
  { value: '480p', label: '480P', short: 480 },
  { value: '720p', label: '720P', short: 720 },
  { value: '1080p', label: '1080P', short: 1080 },
] as const;

export const VIDEO_DURATIONS = [3, 5, 8, 10] as const;

export const CAMERA_MOTIONS = ['自动', '固定', '推镜', '拉镜', '左摇', '右摇', '上升', '下降', '环绕', '跟随'] as const;

export const SHOT_SIZES = ['远景', '全景', '中景', '近景', '特写'] as const;
export const CAMERA_MOVES = ['固定', '推', '拉', '摇', '移', '跟', '环绕', '升降'] as const;

function round16(value: number): number {
  return Math.max(64, Math.round(value / 16) * 16);
}

/** 根据画面比例和短边分辨率计算宽高（对齐到 16 的倍数，适配大部分扩散模型） */
export function dimensions(aspectRatio: string, short: number): { width: number; height: number } {
  const [w, h] = aspectRatio.split(':').map(Number);
  if (!w || !h) return { width: short, height: short };
  return w >= h
    ? { width: round16((short * w) / h), height: round16(short) }
    : { width: round16(short), height: round16((short * h) / w) };
}

export function imageParams(
  aspectRatio: string,
  resolution: string,
  extra: Partial<GenParams> = {},
): GenParams {
  const short = IMAGE_RESOLUTIONS.find((item) => item.value === resolution)?.short ?? 1024;
  return { aspectRatio, resolution, ...dimensions(aspectRatio, short), count: 1, seed: null, ...extra };
}

export function videoParams(
  aspectRatio: string,
  resolution: string,
  extra: Partial<GenParams> = {},
): GenParams {
  const short = VIDEO_RESOLUTIONS.find((item) => item.value === resolution)?.short ?? 720;
  return {
    aspectRatio,
    resolution,
    ...dimensions(aspectRatio, short),
    count: 1,
    seed: null,
    duration: 5,
    fps: 24,
    ...extra,
  };
}

/** CSS aspect-ratio 字符串 */
export function cssRatio(aspectRatio: string): string {
  return aspectRatio.replace(':', ' / ');
}
