// 成片渲染（EXP-03）：heavy 通道的后台作业。按全片顺序取每个镜头的选定视频（按裁剪点截取），
// 没有视频的镜头可以用关键帧做静帧补位；规格一致时无损拼接，否则统一重编码 720p；
// 再把配音按时间线混进去（可选配乐），写入 AI 标识元数据，产物入资产库（purpose=film，带版本号）。
import fs from 'node:fs/promises';
import { VOICE_LEAD, voiceOffsets } from '../../shared/film.ts';
import type { StoryData } from '../../shared/types.ts';
import { db, type Row } from '../db.ts';
import { absoluteFile, newTempFile, saveAsset } from '../files.ts';
import { registerJobKind } from '../jobs/runner.ts';
import { concatVideos, estimateReencode, planConcat, type ConcatClip } from '../media/concat.ts';
import { ffmpeg, hasFfmpeg, probe } from '../media/ffmpeg.ts';
import { effectiveMedia } from './batch.ts';
import { loadStory } from './store.ts';

export interface FilmOptions {
  /** 没有视频的镜头用关键帧做静帧补位（否则跳过） */
  stills?: boolean;
  /** 混入台词配音 */
  voice?: boolean;
  /** 配乐（音频素材 id），铺满全片 */
  musicAssetId?: string | null;
  /** 配乐音量 0–1 */
  musicVolume?: number;
}

interface Piece {
  shotId: string;
  /** 视频文件，或静帧图片（要先转成片段） */
  file: string;
  still: boolean;
  trimIn: number;
  trimOut: number | null;
  length: number;
  lines: { lineId: string; voiceFile: string | null; duration: number }[];
}

export interface FilmPlan {
  ffmpeg: boolean;
  clips: number;
  stills: number;
  missing: { shotId: string; number: number; code: string | null }[];
  voices: number;
  duration: number;
  mode: 'copy' | 'reencode' | null;
  estimateSeconds: number;
  /** 下一个版本号 */
  version: number;
}

function assetFile(id: string | null | undefined): { file: string; duration: number | null } | null {
  if (!id) return null;
  const row = db.prepare('SELECT file, duration FROM assets WHERE id = ? AND deleted_at IS NULL').get(id) as Row | undefined;
  return row ? { file: absoluteFile(String(row.file)), duration: row.duration == null ? null : Number(row.duration) } : null;
}

async function durationOf(entry: { file: string; duration: number | null }): Promise<number> {
  if (entry.duration) return entry.duration;
  if (!hasFfmpeg()) return 0;
  return (await probe(entry.file).catch(() => null))?.duration ?? 0;
}

async function collect(storyId: string, data: StoryData, options: FilmOptions): Promise<{ pieces: Piece[]; missing: FilmPlan['missing'] }> {
  const media = effectiveMedia(storyId);
  const pieces: Piece[] = [];
  const missing: FilmPlan['missing'] = [];
  let number = 0;
  for (const chapter of data.chapters) {
    for (const scene of chapter.scenes) {
      for (const shot of scene.shots) {
        number++;
        const current = media.get(shot.id);
        const video = assetFile(current?.video);
        const keyframe = options.stills ? assetFile(current?.keyframe) : null;
        if (!video && !keyframe) {
          missing.push({ shotId: shot.id, number, code: shot.code ?? null });
          continue;
        }
        let length = Math.max(0.5, shot.duration || 5);
        const trimIn = Math.max(0, shot.trimIn ?? 0);
        const trimOut = shot.trimOut ?? null;
        if (video) {
          const full = await durationOf(video);
          if (full) length = Math.max(0.1, Math.min(full, trimOut ?? full) - Math.min(trimIn, full));
        }
        const lines = [];
        for (const lineId of shot.dialogueIds) {
          const line = scene.dialogue.find((l) => l.id === lineId);
          if (!line) continue;
          const voice = options.voice ? assetFile(line.voiceAssetId) : null;
          lines.push({ lineId, voiceFile: voice?.file ?? null, duration: voice ? await durationOf(voice) : 0 });
        }
        pieces.push({ shotId: shot.id, file: (video ?? keyframe)!.file, still: !video, trimIn: video ? trimIn : 0, trimOut: video ? trimOut : null, length, lines });
      }
    }
  }
  return { pieces, missing };
}

function nextVersion(storyId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE story_id = ? AND purpose = 'film'").get(storyId) as Row;
  return Number(row.n) + 1;
}

/** 试算：多少段、哪些镜头缺视频、拼接方式、预计耗时 */
export async function planFilm(storyId: string, options: FilmOptions): Promise<FilmPlan> {
  const { data } = loadStory(storyId);
  const { pieces, missing } = await collect(storyId, data, options);
  const duration = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const voices = pieces.reduce((sum, piece) => sum + piece.lines.filter((l) => l.voiceFile).length, 0);
  let mode: FilmPlan['mode'] = null;
  if (hasFfmpeg() && pieces.length) {
    const stills = pieces.some((p) => p.still);
    mode = stills ? 'reencode' : (await planConcat(pieces.map(toClip)).catch(() => ({ mode: 'reencode' as const }))).mode;
  }
  return {
    ffmpeg: hasFfmpeg(),
    clips: pieces.length,
    stills: pieces.filter((p) => p.still).length,
    missing,
    voices,
    duration: Math.round(duration * 10) / 10,
    mode,
    estimateSeconds: mode === 'reencode' ? estimateReencode(duration) + 5 : Math.ceil(duration / 20) + 3,
    version: nextVersion(storyId),
  };
}

function toClip(piece: Piece): ConcatClip {
  return { file: piece.file, trimIn: piece.trimIn || undefined, trimOut: piece.trimOut ?? undefined };
}

/** 关键帧转成一段静帧视频（带静音音轨），长度按镜头时长 */
async function stillClip(image: string, seconds: number, output: string, signal: AbortSignal): Promise<void> {
  await ffmpeg(
    [
      '-loop', '1', '-t', seconds.toFixed(2), '-i', image,
      '-f', 'lavfi', '-t', seconds.toFixed(2), '-i', 'anullsrc=r=48000:cl=stereo',
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-shortest', output,
    ],
    { signal, timeoutMs: 5 * 60_000 },
  );
}

export async function renderFilm(
  storyId: string,
  userId: string,
  options: FilmOptions,
  ctx: { signal: AbortSignal; progress: (value: number, stage?: string) => void },
): Promise<{ assetId: string; version: number; mode: 'copy' | 'reencode'; duration: number }> {
  if (!hasFfmpeg()) throw new Error('服务器没有安装 ffmpeg，不能渲染成片');
  const { title, data } = loadStory(storyId);
  const { pieces } = await collect(storyId, data, options);
  if (!pieces.length) throw new Error('还没有可用的镜头视频');
  const temps: string[] = [];
  const temp = async (ext: string) => {
    const file = await newTempFile(ext);
    temps.push(file);
    return file;
  };
  try {
    // 1. 静帧补位
    const clips: ConcatClip[] = [];
    for (const [i, piece] of pieces.entries()) {
      if (piece.still) {
        ctx.progress((i / pieces.length) * 0.15, '准备静帧');
        const file = await temp('mp4');
        await stillClip(piece.file, piece.length, file, ctx.signal);
        clips.push({ file });
      } else clips.push(toClip(piece));
    }
    // 2. 拼接
    ctx.progress(0.15, '拼接镜头');
    const joined = await temp('mp4');
    const result = await concatVideos(clips, joined, {
      signal: ctx.signal,
      forceReencode: pieces.some((p) => p.still),
      onProgress: (fraction) => ctx.progress(0.15 + fraction * 0.65, '拼接镜头'),
    });
    // 3. 混音（配音按时间线放置，配乐循环铺满）+ AI 标识元数据
    ctx.progress(0.82, '混音');
    const inputs: string[] = ['-i', joined];
    const filters: string[] = [];
    const mixes: string[] = [];
    let start = 0;
    let n = 1;
    for (const piece of pieces) {
      const voiced = piece.lines.filter((l) => l.voiceFile);
      const offsets = voiceOffsets(voiced.map((l) => l.duration || 1));
      voiced.forEach((line, i) => {
        const ms = Math.round((start + (offsets[i] ?? VOICE_LEAD)) * 1000);
        inputs.push('-i', line.voiceFile!);
        filters.push(`[${n}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[v${n}]`);
        mixes.push(`[v${n}]`);
        n++;
      });
      start += piece.length;
    }
    const music = options.musicAssetId ? assetFile(options.musicAssetId) : null;
    if (music) {
      inputs.push('-stream_loop', '-1', '-i', music.file);
      const volume = Math.min(1, Math.max(0, options.musicVolume ?? 0.25));
      filters.push(`[${n}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${result.duration.toFixed(2)},volume=${volume}[m]`);
      mixes.push('[m]');
      n++;
    }
    const meta = ['-metadata', `comment=AIGC：本视频由 AI 生成（织影 Weave · ${title}）`, '-metadata', 'AIGC={"label":"AI 生成","generator":"织影 Weave"}', '-metadata', `title=${title}`];
    const output = await temp('mp4');
    if (mixes.length) {
      const probeJoined = await probe(joined);
      const base = probeJoined.audio ? '[0:a]aresample=48000,aformat=channel_layouts=stereo[base]' : `anullsrc=r=48000:cl=stereo,atrim=duration=${result.duration.toFixed(2)}[base]`;
      filters.unshift(base);
      filters.push(`[base]${mixes.join('')}amix=inputs=${mixes.length + 1}:duration=first:normalize=0[aout]`);
      await ffmpeg([...inputs, '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', ...meta, '-movflags', '+faststart+use_metadata_tags', output], {
        signal: ctx.signal,
        timeoutMs: 30 * 60_000,
      });
    } else {
      await ffmpeg(['-i', joined, '-map', '0', '-c', 'copy', ...meta, '-movflags', '+faststart+use_metadata_tags', output], { signal: ctx.signal, timeoutMs: 10 * 60_000 });
    }
    // 4. 入库
    ctx.progress(0.97, '保存');
    const version = nextVersion(storyId);
    const asset = await saveAsset({
      userId,
      kind: 'video',
      source: 'generated',
      mime: 'video/mp4',
      filePath: output,
      storyId,
      purpose: 'film',
      prompt: `${title} · 成片 v${version}`,
      filename: `${title.replace(/[\\/:*?"<>|]/g, '_')}-成片v${version}.mp4`,
      meta: { film: { version, mode: result.mode, clips: pieces.length, stills: pieces.filter((p) => p.still).length, voice: Boolean(options.voice), music: options.musicAssetId ?? null }, aigc: true },
    });
    temps.splice(temps.indexOf(output), 1);
    return { assetId: asset.id, version, mode: result.mode, duration: result.duration };
  } finally {
    await Promise.all(temps.map((file) => fs.rm(file, { force: true })));
  }
}

export function registerFilmJob(): void {
  registerJobKind<{ storyId: string; userId: string; options: FilmOptions }>('story-film', {
    lane: 'heavy',
    maxAttempts: 1,
    handler: async (ctx) => renderFilm(ctx.payload.storyId, ctx.payload.userId, ctx.payload.options ?? {}, ctx),
  });
}

/** 成片版本列表 */
export function filmVersions(storyId: string): Row[] {
  return db.prepare("SELECT * FROM assets WHERE story_id = ? AND purpose = 'film' AND deleted_at IS NULL ORDER BY seq DESC").all(storyId) as Row[];
}
