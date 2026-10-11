// 上传落地：算哈希去重 → 读 PNG 里的生成参数 → 入库。分片上传和旧的单次上传共用。
import fs from 'node:fs/promises';
import type { Asset } from '../../shared/types.ts';
import { db, type Row } from '../db.ts';
import { mediaKindOf, saveAsset } from '../files.ts';
import { readPngMeta } from '../media/png-meta.ts';
import { loadAsset } from '../repo.ts';
import { sha256File } from './derive.ts';

export interface UploadInfo {
  filename: string;
  mime: string;
  folderId?: string | null;
  storyId?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface UploadResult {
  asset: Asset;
  /** 同一个文件之前上传过：直接返回已有的素材，不重复占用空间 */
  duplicate: boolean;
}

export async function finalizeUpload(userId: string, tempFile: string, info: UploadInfo): Promise<UploadResult> {
  const sha256 = await sha256File(tempFile);
  const existing = db
    .prepare('SELECT id FROM assets WHERE user_id = ? AND sha256 = ? AND deleted_at IS NULL ORDER BY seq LIMIT 1')
    .get(userId, sha256) as Row | undefined;
  if (existing) {
    await fs.rm(tempFile, { force: true });
    return { asset: loadAsset(String(existing.id))!, duplicate: true };
  }
  const meta = info.mime === 'image/png' ? await readPngMeta(tempFile) : null;
  const asset = await saveAsset({
    userId,
    kind: mediaKindOf(info.mime),
    source: 'upload',
    mime: info.mime,
    filePath: tempFile,
    width: info.width ?? null,
    height: info.height ?? null,
    filename: info.filename.slice(0, 200),
    sha256,
    prompt: meta?.prompt ?? null,
    meta: meta ? { png: { prompt: meta.prompt, negative: meta.negative, seed: meta.seed, keys: Object.keys(meta.text) } } : null,
    folderId: info.folderId ?? null,
    storyId: info.storyId ?? null,
  });
  return { asset, duplicate: false };
}
