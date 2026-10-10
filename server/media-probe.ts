// 读文件头拿到图片 / 视频的真实宽高和时长，纯 JS，不依赖 ffmpeg（NAS 上省资源）。
// 支持 PNG、JPEG、GIF、WEBP 和 MP4 / MOV（ISO BMFF）。认不出时返回空。
import fs from 'node:fs/promises';

export interface MediaInfo {
  width?: number;
  height?: number;
  /** 秒 */
  duration?: number;
}

async function readAt(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function probeImage(head: Buffer): MediaInfo | null {
  // PNG
  if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47) {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  // GIF
  if (head.subarray(0, 3).toString('ascii') === 'GIF' && head.length >= 10) {
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  }
  // WEBP
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') {
    const format = head.subarray(12, 16).toString('ascii');
    if (format === 'VP8 ' && head.length >= 30) {
      return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
    }
    if (format === 'VP8L' && head.length >= 25) {
      const bits = head.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (format === 'VP8X' && head.length >= 30) {
      return { width: head.readUIntLE(24, 3) + 1, height: head.readUIntLE(27, 3) + 1 };
    }
  }
  // JPEG：找 SOF 段
  if (head[0] === 0xff && head[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < head.length) {
      if (head[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = head[offset + 1];
      const length = head.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: head.readUInt16BE(offset + 5), width: head.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

/** 遍历 ISO BMFF 盒子，找 moov/mvhd（时长）和第一个有尺寸的 trak/tkhd（宽高） */
async function probeMp4(handle: fs.FileHandle, size: number): Promise<MediaInfo | null> {
  const info: MediaInfo = {};
  async function walk(start: number, end: number, depth: number): Promise<void> {
    let offset = start;
    while (offset + 8 <= end && depth < 6) {
      const header = await readAt(handle, offset, 16);
      if (header.length < 8) return;
      let boxSize = header.readUInt32BE(0);
      const type = header.subarray(4, 8).toString('latin1');
      let headerSize = 8;
      if (boxSize === 1 && header.length >= 16) {
        boxSize = Number(header.readBigUInt64BE(8));
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = end - offset;
      }
      if (boxSize < headerSize) return;
      if (type === 'moov' || type === 'trak') {
        await walk(offset + headerSize, offset + boxSize, depth + 1);
      } else if (type === 'mvhd') {
        const body = await readAt(handle, offset + headerSize, 32);
        const version = body[0];
        const timescale = version === 1 ? body.readUInt32BE(20) : body.readUInt32BE(12);
        const duration = version === 1 ? Number(body.readBigUInt64BE(24)) : body.readUInt32BE(16);
        if (timescale) info.duration = Math.round((duration / timescale) * 100) / 100;
      } else if (type === 'tkhd' && !info.width) {
        const body = await readAt(handle, offset + headerSize, 96);
        const base = body[0] === 1 ? 88 : 76;
        if (body.length >= base + 8) {
          const width = body.readUInt32BE(base) / 65536;
          const height = body.readUInt32BE(base + 4) / 65536;
          if (width > 0 && height > 0) {
            info.width = Math.round(width);
            info.height = Math.round(height);
          }
        }
      }
      offset += boxSize;
    }
  }
  await walk(0, size, 0);
  return info.width || info.duration ? info : null;
}

export async function probeMedia(file: string): Promise<MediaInfo> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const head = await readAt(handle, 0, 64 * 1024);
    const image = probeImage(head);
    if (image) return image;
    if (head.subarray(4, 8).toString('latin1') === 'ftyp') return (await probeMp4(handle, size)) ?? {};
    return {};
  } catch {
    return {};
  } finally {
    await handle?.close();
  }
}
