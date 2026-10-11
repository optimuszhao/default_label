// 截帧为新素材（AST-14）：资产库、续拍、长镜头接力、故事"接续上一镜尾帧"都用这里。
import fs from 'node:fs/promises';
import type { Asset } from '../../shared/types.ts';
import { absoluteFile, newTempFile, saveAsset } from '../files.ts';
import { extractFrame, hasFfmpeg } from '../media/ffmpeg.ts';
import { getAssetRow } from '../repo.ts';

export interface FrameOptions {
  /** 缩放裁切到算子需要的输入尺寸 */
  size?: { width: number; height: number };
  storyId?: string | null;
  shotId?: string | null;
}

export async function frameFromAsset(userId: string, assetId: string, at: number | 'last', options: FrameOptions = {}): Promise<Asset> {
  if (!hasFfmpeg()) throw new Error('服务器没有安装 ffmpeg，无法截帧');
  const row = getAssetRow(assetId);
  if (!row || row.user_id !== userId) throw new Error('素材不存在');
  if (row.kind !== 'video') throw new Error('只能从视频截帧');
  const temp = await newTempFile('png');
  try {
    await extractFrame(absoluteFile(String(row.file)), temp, at, options.size);
    const label = at === 'last' ? '尾帧' : `${Number(at).toFixed(1)} 秒`;
    return await saveAsset({
      userId,
      kind: 'image',
      source: 'generated',
      mime: 'image/png',
      filePath: temp,
      prompt: (row.prompt as string | null) ?? null,
      parentAssetId: assetId,
      lineage: 'frame',
      note: `截自视频 ${label}`,
      storyId: options.storyId ?? null,
      shotId: options.shotId ?? null,
    });
  } finally {
    await fs.rm(temp, { force: true });
  }
}
