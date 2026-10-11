// 拼接视频：所有片段的编码、分辨率、帧率、像素格式、时间基都一致时用 concat demuxer + -c copy（几乎瞬间完成）；
// 不一致时统一重编码成 720p H.264（缩放加黑边，24fps），可以取消，不残留临时文件。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg, probe, sameSpec, type ProbeResult } from './ffmpeg.ts';

export interface ConcatClip {
  file: string;
  /** 裁剪：从第几秒开始、到第几秒结束（不填用整段） */
  trimIn?: number;
  trimOut?: number;
}

export interface ConcatResult {
  mode: 'copy' | 'reencode';
  duration: number;
}

function needsTrim(clip: ConcatClip): boolean {
  return (clip.trimIn ?? 0) > 0 || clip.trimOut != null;
}

/** 预估重编码耗时（秒）：按总时长的 1.5 倍粗估 */
export function estimateReencode(totalSeconds: number): number {
  return Math.round(totalSeconds * 1.5);
}

export async function planConcat(clips: ConcatClip[]): Promise<{ mode: 'copy' | 'reencode'; infos: ProbeResult[]; duration: number }> {
  const infos = await Promise.all(clips.map((clip) => probe(clip.file)));
  const copy = infos.every((info) => sameSpec(info, infos[0])) && !clips.some(needsTrim) && infos.every((info) => !info.audio || info.audio.codec === infos[0].audio?.codec);
  const duration = clips.reduce((sum, clip, i) => sum + Math.max(0, (clip.trimOut ?? infos[i].duration ?? 0) - (clip.trimIn ?? 0)), 0);
  return { mode: copy ? 'copy' : 'reencode', infos, duration };
}

export async function concatVideos(
  clips: ConcatClip[],
  output: string,
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void; forceReencode?: boolean; height?: number } = {},
): Promise<ConcatResult> {
  if (!clips.length) throw new Error('没有可拼接的片段');
  const plan = await planConcat(clips);
  const mode = options.forceReencode ? 'reencode' : plan.mode;
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-concat-'));
  try {
    if (mode === 'copy') {
      const list = path.join(work, 'list.txt');
      await fs.writeFile(list, clips.map((clip) => `file '${clip.file.replace(/'/g, "'\\''")}'`).join('\n'));
      await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', output], {
        signal: options.signal,
        timeoutMs: 10 * 60_000,
        onProgress: (seconds) => options.onProgress?.(Math.min(1, seconds / Math.max(1, plan.duration))),
      });
      return { mode, duration: plan.duration };
    }
    // 重编码：每段缩放到同一尺寸（保持比例、补黑边），没有音轨的补一段静音，再 concat 滤镜拼起来
    const height = options.height ?? 720;
    const first = plan.infos[0].video;
    const ratio = first?.width && first?.height ? first.width / first.height : 16 / 9;
    const width = Math.round((height * ratio) / 2) * 2;
    const args: string[] = [];
    const filters: string[] = [];
    clips.forEach((clip, i) => {
      if (clip.trimIn) args.push('-ss', String(clip.trimIn));
      if (clip.trimOut != null) args.push('-to', String(clip.trimOut));
      args.push('-i', clip.file);
    });
    clips.forEach((_, i) => {
      filters.push(`[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v${i}]`);
      if (plan.infos[i].audio) filters.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
      else {
        const length = Math.max(0.1, (clips[i].trimOut ?? plan.infos[i].duration ?? 1) - (clips[i].trimIn ?? 0));
        filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${length.toFixed(3)}[a${i}]`);
      }
    });
    filters.push(`${clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${clips.length}:v=1:a=1[v][a]`);
    await ffmpeg([...args, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output], {
      signal: options.signal,
      timeoutMs: 60 * 60_000,
      onProgress: (seconds) => options.onProgress?.(Math.min(1, seconds / Math.max(1, plan.duration))),
    });
    return { mode, duration: plan.duration };
  } catch (error) {
    await fs.rm(output, { force: true });
    throw error;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
