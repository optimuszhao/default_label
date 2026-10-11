// ffmpeg / ffprobe 封装：缩略图、视频封面、截帧、拼接都走这里。
// 镜像默认内置 ffmpeg；本机开发或精简镜像里没有时，hasFfmpeg() 返回 false，调用方自行降级。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

let available: boolean | null = null;

/** ffmpeg 和 ffprobe 都能执行才算可用（结果缓存） */
export function hasFfmpeg(): boolean {
  if (available === null) {
    const ok = (bin: string) => {
      try {
        return spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
      } catch {
        return false;
      }
    };
    available = ok(FFMPEG) && ok(FFPROBE);
  }
  return available;
}

export class FfmpegError extends Error {}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 解析 stderr 里的 time=，换算成 0–1 进度（需要给出总时长） */
  onProgress?: (seconds: number) => void;
}

function run(bin: string, args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new FfmpegError('已取消'));
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      // 只保留最后 8 KB，长视频的进度输出很多
      stderr = (stderr + text).slice(-8192);
      if (options.onProgress) {
        const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
        if (match) options.onProgress(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
      }
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new FfmpegError(`${path.basename(bin)} 超时`));
    }, options.timeoutMs ?? 120_000);
    const onAbort = () => {
      child.kill('SIGKILL');
      reject(new FfmpegError('已取消'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new FfmpegError(`无法执行 ${path.basename(bin)}：${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new FfmpegError(`${path.basename(bin)} 失败（${code}）：${stderr.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

export function ffmpeg(args: string[], options?: RunOptions) {
  return run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], options);
}

export interface StreamInfo {
  codec: string;
  width?: number;
  height?: number;
  fps?: number;
  pixFmt?: string;
  timeBase?: string;
  sampleRate?: number;
  channels?: number;
}

export interface ProbeResult {
  duration: number | null;
  video: StreamInfo | null;
  audio: StreamInfo | null;
  format: string;
}

function parseRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den) return undefined;
  return Math.round((num / den) * 1000) / 1000;
}

export async function probe(file: string, options?: RunOptions): Promise<ProbeResult> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
    timeoutMs: 30_000,
    ...options,
  });
  const data = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: (Record<string, string | number | undefined> & { disposition?: { attached_pic?: number } })[];
  };
  const streams = data.streams ?? [];
  // 音频文件里的封面图也是一条 video 流（attached_pic），不算画面
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    format: data.format?.format_name ?? '',
    video: v
      ? {
          codec: String(v.codec_name ?? ''),
          width: Number(v.width) || undefined,
          height: Number(v.height) || undefined,
          fps: parseRate(v.avg_frame_rate as string) ?? parseRate(v.r_frame_rate as string),
          pixFmt: (v.pix_fmt as string) ?? undefined,
          timeBase: (v.time_base as string) ?? undefined,
        }
      : null,
    audio: a
      ? {
          codec: String(a.codec_name ?? ''),
          sampleRate: Number(a.sample_rate) || undefined,
          channels: Number(a.channels) || undefined,
        }
      : null,
  };
}

/** 长边缩放到 maxSide（不放大）的 scale 滤镜 */
function fitFilter(maxSide: number): string {
  return `scale='if(gte(iw,ih),min(${maxSide},iw),-2)':'if(gte(iw,ih),-2,min(${maxSide},ih))'`;
}

/** 图片或视频的一帧缩略图：长边 maxSide，WebP */
export async function makeThumbnail(input: string, output: string, kind: 'image' | 'video', maxSide = 384): Promise<void> {
  await fs.mkdir(path.dirname(output), { recursive: true });
  const seek = kind === 'video' ? ['-ss', '0.5'] : [];
  try {
    await ffmpeg([...seek, '-i', input, '-frames:v', '1', '-vf', fitFilter(maxSide), '-c:v', 'libwebp', '-quality', '78', output], { timeoutMs: 60_000 });
  } catch (error) {
    // 不到 0.5 秒的视频：从第一帧取
    if (kind !== 'video') throw error;
    await ffmpeg(['-i', input, '-frames:v', '1', '-vf', fitFilter(maxSide), '-c:v', 'libwebp', '-quality', '78', output], { timeoutMs: 60_000 });
  }
}

/** 视频封面：0.5 秒处一帧，长边不超过 1280，JPEG */
export async function makePoster(input: string, output: string): Promise<void> {
  await fs.mkdir(path.dirname(output), { recursive: true });
  try {
    await ffmpeg(['-ss', '0.5', '-i', input, '-frames:v', '1', '-vf', fitFilter(1280), '-q:v', '3', output], { timeoutMs: 60_000 });
  } catch {
    await ffmpeg(['-i', input, '-frames:v', '1', '-vf', fitFilter(1280), '-q:v', '3', output], { timeoutMs: 60_000 });
  }
}

/**
 * 截取一帧为 PNG。at 为秒数；'last' 表示尾帧（倒数 0.2 秒处）。
 * size 给出时缩放并居中裁切到这个尺寸（图生视频需要算子要求的输入尺寸）。
 */
export async function extractFrame(input: string, output: string, at: number | 'last', size?: { width: number; height: number }): Promise<void> {
  await fs.mkdir(path.dirname(output), { recursive: true });
  const vf = size ? ['-vf', `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height}`] : [];
  const seek = at === 'last' ? ['-sseof', '-0.2'] : ['-ss', String(Math.max(0, at))];
  try {
    await ffmpeg([...seek, '-i', input, '-frames:v', '1', ...vf, '-update', '1', output], { timeoutMs: 60_000 });
  } catch (error) {
    if (at !== 'last') throw error;
    // 太短的视频 -sseof 会越界：改为取倒数第一帧
    await ffmpeg(['-i', input, '-vf', `${size ? `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height},` : ''}reverse`, '-frames:v', '1', '-update', '1', output], { timeoutMs: 120_000 });
  }
  const stat = await fs.stat(output).catch(() => null);
  if (!stat || stat.size === 0) throw new FfmpegError('没有截到画面（时间点超出视频长度？）');
}

/** 两段视频能否直接用 -c copy 拼接：编码、分辨率、帧率、像素格式都一致 */
export function sameSpec(a: ProbeResult, b: ProbeResult): boolean {
  const va = a.video;
  const vb = b.video;
  if (!va || !vb) return false;
  return va.codec === vb.codec && va.width === vb.width && va.height === vb.height && va.fps === vb.fps && va.pixFmt === vb.pixFmt && va.timeBase === vb.timeBase;
}
