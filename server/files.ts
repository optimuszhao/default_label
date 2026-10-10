import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Asset, GenInfo, MediaKind } from '../shared/types.ts';
import { config } from './config.ts';
import { db, newId, now, type Row } from './db.ts';
import { probeMedia } from './media-probe.ts';
import { toAsset } from './repo.ts';

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

export const ALLOWED_UPLOAD_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm']);

export function filesDir(): string {
  return config.mediaDir;
}

/**
 * 素材按「用户 / 日期」分目录，文件名带时间和类型，方便直接在 NAS 上按日期浏览：
 *   <MEDIA_DIR>/<用户 id>/2026-10-10/142305-video-a_xxxx.mp4
 */
function relativePath(userId: string, id: string, kind: MediaKind, source: Asset['source'], ext: string): string {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const label = source === 'upload' ? 'upload' : kind;
  return `${userId}/${day}/${time}-${label}-${id}.${ext}`;
}

export function absoluteFile(file: string): string {
  return path.join(filesDir(), file);
}

/** 下载中的临时文件放在媒体目录下，和正式文件同一个磁盘，完成后原子 rename */
export function tempDir(): string {
  return path.join(filesDir(), '.tmp');
}

export async function newTempFile(ext = 'partial'): Promise<string> {
  await fs.mkdir(tempDir(), { recursive: true });
  return path.join(tempDir(), `${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`);
}

/** 启动时清理上次异常退出留下的临时文件 */
export async function cleanTempDir(): Promise<void> {
  await fs.rm(tempDir(), { recursive: true, force: true });
}

export interface SaveAssetInput {
  userId: string;
  kind: MediaKind;
  source: Asset['source'];
  mime: string;
  /** 二选一：内存数据，或一个本地临时文件（会被移动过去） */
  data?: Buffer;
  filePath?: string;
  width?: number | null;
  height?: number | null;
  prompt?: string | null;
  taskId?: string | null;
  storyId?: string | null;
  shotId?: string | null;
  purpose?: Asset['purpose'];
  gen?: GenInfo | null;
}

export async function saveAsset(input: SaveAssetInput): Promise<Asset> {
  const id = newId('a_');
  const ext = EXT[input.mime] ?? 'bin';
  const file = relativePath(input.userId, id, input.kind, input.source, ext);
  const target = absoluteFile(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (input.filePath) {
    await fs.rename(input.filePath, target);
  } else if (input.data) {
    await fs.writeFile(target, input.data);
  } else {
    throw new Error('saveAsset 缺少文件内容');
  }
  // 以文件头里的真实尺寸为准（例如超分后的视频比提交时大一倍）
  const probed = await probeMedia(target);
  const width = probed.width ?? input.width ?? null;
  const height = probed.height ?? input.height ?? null;
  const gen = input.gen ? { ...input.gen, width, height, ...(probed.duration ? { duration: probed.duration } : {}) } : null;
  try {
    db.prepare(
      `INSERT INTO assets (id, user_id, kind, source, mime, file, width, height, duration, prompt, task_id, story_id, shot_id, purpose, gen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.userId,
      input.kind,
      input.source,
      input.mime,
      file,
      width,
      height,
      probed.duration ?? null,
      input.prompt ?? null,
      input.taskId ?? null,
      input.storyId ?? null,
      input.shotId ?? null,
      input.purpose ?? null,
      gen ? JSON.stringify(gen) : null,
      now(),
    );
  } catch (error) {
    await fs.rm(target, { force: true });
    throw error;
  }
  return toAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Row);
}

export async function deleteAssetFile(file: string): Promise<void> {
  await fs.rm(absoluteFile(file), { force: true });
}
