// 资产的衍生信息：大小、sha256、编码、时长、缩略图、视频封面。由后台作业生成，入库时立即入队，
// 旧素材由回填作业慢慢补上。没有 ffmpeg 时只补大小和哈希，缩略图降级为原图。
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { publish } from '../bus.ts';
import { config } from '../config.ts';
import { db, now, type Row } from '../db.ts';
import { absoluteFile, purgeAsset, queueDerive, thumbFile } from '../files.ts';
import { enqueueJob, everyInterval, registerJobKind } from '../jobs/runner.ts';
import { logger } from '../log.ts';
import { hasFfmpeg, makePoster, makeThumbnail, probe } from '../media/ffmpeg.ts';
import { getAssetRow, loadAsset } from '../repo.ts';

export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function set(id: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE assets SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((key) => fields[key] as never), id);
}

export async function deriveAsset(id: string, signal?: AbortSignal): Promise<void> {
  const row = getAssetRow(id);
  if (!row) return;
  const file = absoluteFile(String(row.file));
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) {
    set(id, { derive_state: 'failed' });
    return;
  }
  const fields: Record<string, unknown> = {};
  if (row.size == null) fields.size = stat.size;
  if (!row.sha256) fields.sha256 = await sha256File(file, signal);
  const mime = String(row.mime);
  const kind = String(row.kind);
  if (!hasFfmpeg() || mime === 'image/svg+xml') {
    set(id, { ...fields, derive_state: 'skip' });
    return;
  }
  let state = 'ok';
  try {
    const info = await probe(file, { signal });
    if (kind === 'video') {
      fields.codec = info.video?.codec ?? null;
      if (row.duration == null && info.duration) fields.duration = info.duration;
      if (row.width == null && info.video?.width) fields.width = info.video.width;
      if (row.height == null && info.video?.height) fields.height = info.video.height;
    } else if (kind === 'audio') {
      fields.codec = info.audio?.codec ?? null;
      if (info.duration) fields.duration = info.duration;
    } else {
      fields.codec = info.video?.codec ?? null;
      if (row.width == null && info.video?.width) fields.width = info.video.width;
      if (row.height == null && info.video?.height) fields.height = info.video.height;
    }
    const base = `${row.user_id}/${id}`;
    if (kind === 'image' || kind === 'video') {
      await makeThumbnail(file, thumbFile(`${base}.webp`), kind as 'image' | 'video');
      fields.thumb = `${base}.webp`;
    }
    if (kind === 'video') {
      await makePoster(file, thumbFile(`${base}.jpg`));
      fields.poster = `${base}.jpg`;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // 文件损坏或编码不支持：记为失败，界面上退回显示原文件
    state = 'failed';
    logger.debug({ err: error, assetId: id }, '生成缩略图失败');
  }
  set(id, { ...fields, derive_state: state });
  const asset = loadAsset(id);
  if (asset) publish(String(row.user_id), { type: 'asset', asset });
}

/** 回收站里超过保留天数的素材彻底删除 */
export async function purgeTrash(): Promise<number> {
  const cutoff = now() - config.trashDays * 86_400_000;
  const rows = db.prepare('SELECT * FROM assets WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 2000').all(cutoff) as Row[];
  for (const row of rows) await purgeAsset(row);
  return rows.length;
}

/** 24 小时没有完成的分片上传：删掉临时文件 */
async function cleanUploads(): Promise<number> {
  const rows = db.prepare('SELECT * FROM uploads WHERE updated_at < ?').all(now() - 86_400_000) as Row[];
  for (const row of rows) {
    await fs.rm(String(row.temp_file), { force: true });
    db.prepare('DELETE FROM uploads WHERE id = ?').run(String(row.id));
  }
  return rows.length;
}

export function registerLibraryJobs(): void {
  registerJobKind<{ assetId: string }>('asset-derive', {
    maxAttempts: 2,
    handler: async (ctx) => deriveAsset(ctx.payload.assetId, ctx.signal),
  });

  // 回填：每次挑 200 个还没生成衍生信息的素材入队，还有剩余就稍后再来
  registerJobKind('asset-backfill', {
    maxAttempts: 1,
    handler: async () => {
      const rows = db
        .prepare("SELECT id, user_id FROM assets WHERE derive_state = 'pending' AND deleted_at IS NULL ORDER BY seq DESC LIMIT 200")
        .all() as Row[];
      for (const row of rows) queueDerive(String(row.id), null);
      if (rows.length === 200) enqueueJob('asset-backfill', {}, { dedupeKey: 'asset-backfill', runAfter: now() + 60_000 });
      return { queued: rows.length };
    },
  });

  registerJobKind('library-cleanup', {
    maxAttempts: 1,
    handler: async () => ({ purged: await purgeTrash(), uploads: await cleanUploads() }),
  });

  everyInterval('library-cleanup', 6 * 3600_000);
}

/** 启动时：之前因为没有 ffmpeg 跳过的素材，现在有了就重新生成；然后开始回填 */
export function startLibraryBackfill(): void {
  if (hasFfmpeg()) db.prepare("UPDATE assets SET derive_state = 'pending' WHERE derive_state = 'skip' AND mime <> 'image/svg+xml'").run();
  const pending = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE derive_state = 'pending' AND deleted_at IS NULL").get() as Row;
  if (Number(pending.n) > 0) enqueueJob('asset-backfill', {}, { dedupeKey: 'asset-backfill' });
}
