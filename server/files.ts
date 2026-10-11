import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Asset, GenInfo, MediaKind } from '../shared/types.ts';
import { config } from './config.ts';
import { db, newId, now, type Row } from './db.ts';
import { enqueueJob } from './jobs/runner.ts';
import { logger } from './log.ts';
import { probeMedia } from './media-probe.ts';
import { loadAsset } from './repo.ts';

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
  'audio/flac': 'flac',
};

export const ALLOWED_UPLOAD_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
]);

export function mediaKindOf(mime: string): MediaKind {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'image';
}

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

/** 缩略图、封面这类衍生文件放在 DATA_DIR/thumbs（小文件，跟数据库放在同一块盘上） */
export function thumbsDir(): string {
  return path.join(config.dataDir, 'thumbs');
}

export function thumbFile(file: string): string {
  return path.join(thumbsDir(), file);
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
  parentAssetId?: string | null;
  lineage?: Asset['lineage'];
  filename?: string | null;
  /** 已经算好的 sha256（上传时为了去重会先算），没有则由后台作业补上 */
  sha256?: string | null;
  meta?: Record<string, unknown> | null;
  folderId?: string | null;
  note?: string;
}

export async function saveAsset(input: SaveAssetInput): Promise<Asset> {
  const id = newId('a_');
  const ext = EXT[input.mime] ?? 'bin';
  const file = relativePath(input.userId, id, input.kind, input.source, ext);
  const target = absoluteFile(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (input.filePath) {
    try {
      await fs.rename(input.filePath, target);
    } catch (error) {
      // 跨磁盘（临时目录在另一块盘）时 rename 会失败，改为复制
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await fs.copyFile(input.filePath, target);
      await fs.rm(input.filePath, { force: true });
    }
  } else if (input.data) {
    await fs.writeFile(target, input.data);
  } else {
    throw new Error('saveAsset 缺少文件内容');
  }
  // 以文件头里的真实尺寸为准（例如超分后的视频比提交时大一倍）
  const probed = input.kind === 'audio' ? {} : await probeMedia(target);
  const size = (await fs.stat(target)).size;
  const width = probed.width ?? input.width ?? null;
  const height = probed.height ?? input.height ?? null;
  const gen = input.gen ? { ...input.gen, width, height, ...(probed.duration ? { duration: probed.duration } : {}) } : null;
  try {
    db.prepare(
      `INSERT INTO assets (id, user_id, kind, source, mime, file, width, height, duration, prompt, task_id, story_id, shot_id, purpose, gen,
         parent_asset_id, lineage, filename, sha256, meta, folder_id, note, size, seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM assets), ?)`,
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
      input.parentAssetId ?? null,
      input.lineage ?? (input.parentAssetId ? 'derive' : null),
      input.filename ?? null,
      input.sha256 ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
      input.folderId ?? null,
      input.note ?? '',
      size,
      now(),
    );
  } catch (error) {
    await fs.rm(target, { force: true });
    throw error;
  }
  indexAsset(id);
  queueDerive(id, input.userId);
  return loadAsset(id)!;
}

/** 让后台作业补齐哈希、编码信息、缩略图和封面 */
export function queueDerive(assetId: string, userId: string | null = null): void {
  try {
    enqueueJob('asset-derive', { assetId }, { userId, dedupeKey: `derive:${assetId}` });
  } catch (error) {
    // 作业系统没启动（例如运维脚本里）：之后由回填作业补上
    logger.debug({ err: error, assetId }, '衍生文件作业未入队');
  }
}

/**
 * 全文索引：提示词、备注、原文件名、标签、所属故事名，一起写进 assets_fts（rowid = seq）。
 * 修改备注、标签、所属故事后都要调用。
 */
export function indexAsset(...ids: string[]): void {
  for (const id of ids) {
    const row = db
      .prepare(
        `SELECT a.seq, a.prompt, a.note, a.filename, s.title AS story_title,
           (SELECT group_concat(t.name, ' ') FROM asset_tags at JOIN tags t ON t.id = at.tag_id WHERE at.asset_id = a.id) AS tag_names,
           (SELECT sh.description || ' ' || sh.code FROM story_shots sh WHERE sh.id = a.shot_id) AS shot_text,
           (SELECT group_concat(e.name, ' ') FROM shot_elements se JOIN story_elements e ON e.id = se.element_id WHERE se.shot_id = a.shot_id) AS element_names,
           (SELECT group_concat(e.name, ' ') FROM entity_assets ea JOIN story_elements e ON e.id = ea.entity_id WHERE ea.asset_id = a.id) AS used_by
         FROM assets a LEFT JOIN stories s ON s.id = a.story_id WHERE a.id = ?`,
      )
      .get(id) as Row | undefined;
    if (!row || row.seq == null) continue;
    // 资产也能按所在镜头的描述 / 编号、出镜设定名、被哪些设定用作参考图来搜（STY-18）
    const body = [row.prompt, row.note, row.filename, row.tag_names, row.story_title, row.shot_text, row.element_names, row.used_by].filter(Boolean).join('\n');
    db.prepare('DELETE FROM assets_fts WHERE rowid = ?').run(Number(row.seq));
    db.prepare('INSERT INTO assets_fts (rowid, body) VALUES (?, ?)').run(Number(row.seq), body);
  }
}

/** 彻底删除一个素材的文件和衍生文件 */
export async function deleteAssetFiles(row: Row): Promise<void> {
  await fs.rm(absoluteFile(String(row.file)), { force: true });
  if (row.thumb) await fs.rm(thumbFile(String(row.thumb)), { force: true });
  if (row.poster) await fs.rm(thumbFile(String(row.poster)), { force: true });
}

/** 彻底删除：数据库行、索引、标签关联、文件 */
export async function purgeAsset(row: Row): Promise<void> {
  db.prepare('DELETE FROM assets_fts WHERE rowid = ?').run(Number(row.seq ?? -1));
  db.prepare('DELETE FROM asset_tags WHERE asset_id = ?').run(String(row.id));
  db.prepare('DELETE FROM assets WHERE id = ?').run(String(row.id));
  await deleteAssetFiles(row);
}

export async function deleteAssetFile(file: string): Promise<void> {
  await fs.rm(absoluteFile(file), { force: true });
}
