import { clampDuration, DEFAULT_CAPABILITIES, resolveSize, type Capabilities } from '../../../shared/operator.ts';
import type { GenParams } from '../../../shared/types.ts';

export { ASPECT_RATIOS, IMAGE_RESOLUTIONS, VIDEO_RESOLUTIONS } from '../../../shared/operator.ts';

export const CAMERA_MOTIONS = ['自动', '固定', '推镜', '拉镜', '左摇', '右摇', '上升', '下降', '环绕', '跟随'] as const;

export const SHOT_SIZES = ['远景', '全景', '中景', '近景', '特写'] as const;
export const CAMERA_MOVES = ['固定', '推', '拉', '摇', '移', '跟', '环绕', '升降'] as const;

export function imageParams(
  aspectRatio: string,
  resolution: string,
  extra: Partial<GenParams> = {},
  caps: Capabilities = DEFAULT_CAPABILITIES,
): GenParams {
  return { aspectRatio, resolution, ...resolveSize(caps.image, aspectRatio, resolution), count: 1, seed: null, ...extra };
}

/** 视频参数：尺寸按算子能力（有原生尺寸时用原生尺寸），时长收进支持范围 */
export function videoParams(
  aspectRatio: string,
  resolution: string,
  extra: Partial<GenParams> = {},
  caps: Capabilities = DEFAULT_CAPABILITIES,
): GenParams {
  const params: GenParams = {
    aspectRatio,
    resolution,
    ...resolveSize(caps.video, aspectRatio, resolution),
    count: 1,
    seed: null,
    duration: 5,
    fps: 24,
    ...extra,
  };
  if (params.duration != null) params.duration = clampDuration(caps.video, params.duration);
  return params;
}

/** CSS aspect-ratio 字符串 */
export function cssRatio(aspectRatio: string): string {
  return aspectRatio.replace(':', ' / ');
}
