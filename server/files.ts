import fs from 'node:fs/promises';
import path from 'node:path';
import type { Asset, MediaKind } from '../shared/types.ts';
import { config } from './config.ts';
import { db, newId, now, type Row } from './db.ts';
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

export interface SaveAssetInput {
  userId: string;
  kind: MediaKind;
  source: Asset['source'];
  mime: string;
  data: Buffer;
  width?: number | null;
  height?: number | null;
  prompt?: string | null;
  taskId?: string | null;
  storyId?: string | null;
  shotId?: string | null;
  purpose?: Asset['purpose'];
}

export async function saveAsset(input: SaveAssetInput): Promise<Asset> {
  const id = newId('a_');
  const ext = EXT[input.mime] ?? 'bin';
  const file = relativePath(input.userId, id, input.kind, input.source, ext);
  await fs.mkdir(path.dirname(absoluteFile(file)), { recursive: true });
  await fs.writeFile(absoluteFile(file), input.data);
  db.prepare(
    `INSERT INTO assets (id, user_id, kind, source, mime, file, width, height, prompt, task_id, story_id, shot_id, purpose, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.kind,
    input.source,
    input.mime,
    file,
    input.width ?? null,
    input.height ?? null,
    input.prompt ?? null,
    input.taskId ?? null,
    input.storyId ?? null,
    input.shotId ?? null,
    input.purpose ?? null,
    now(),
  );
  return toAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Row);
}

export async function deleteAssetFile(file: string): Promise<void> {
  await fs.rm(absoluteFile(file), { force: true });
}
