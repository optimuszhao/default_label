// 流式 zip：只打包不压缩（图片、视频本身已经压缩过），边读边写，内存占用和文件大小无关。
// 超过 4 GB 的文件、偏移或超过 65535 个条目时自动使用 zip64 扩展。
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { Writable } from 'node:stream';
import { crc32 } from 'node:zlib';

export interface ZipEntry {
  /** 包内路径，用 / 分隔 */
  name: string;
  /** 二选一：磁盘文件或内存数据 */
  file?: string;
  data?: Buffer | string;
  mtime?: Date;
}

const MAX32 = 0xffffffff;

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function u16(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
}
function u32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  return buf;
}
function u64(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

/** 包内文件名：去掉非法字符，重名自动加序号 */
export function uniqueNames(): (name: string) => string {
  const seen = new Map<string, number>();
  return (raw) => {
    const name = raw.replace(/[\\:*?"<>|\u0000-\u001f]/g, '_').replace(/^\/+/, '') || 'file';
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (${count})${name.slice(dot)}` : `${name} (${count})`;
  };
}

interface Written {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
  zip64: boolean;
}

export async function writeZip(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>, out: Writable, signal?: AbortSignal): Promise<void> {
  let offset = 0;
  const written: Written[] = [];

  const write = (chunk: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('已取消'));
      offset += chunk.length;
      if (out.write(chunk)) resolve();
      else {
        const onDrain = () => {
          out.off('error', onError);
          resolve();
        };
        const onError = (error: Error) => {
          out.off('drain', onDrain);
          reject(error);
        };
        out.once('drain', onDrain);
        out.once('error', onError);
      }
    });

  for await (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const size = data ? data.length : (await fs.stat(entry.file!)).size;
    const { time, date } = dosDateTime(entry.mtime ?? new Date());
    const zip64 = size >= MAX32 || offset >= MAX32;
    const headerOffset = offset;
    const extra = zip64 ? Buffer.concat([u16(0x0001), u16(16), u64(0), u64(0)]) : Buffer.alloc(0);
    await write(
      Buffer.concat([
        u32(0x04034b50),
        u16(zip64 ? 45 : 20),
        u16(0x0808), // bit 3：大小和 CRC 写在数据后面；bit 11：文件名是 UTF-8
        u16(0), // 不压缩
        u16(time),
        u16(date),
        u32(0),
        u32(zip64 ? MAX32 : 0),
        u32(zip64 ? MAX32 : 0),
        u16(name.length),
        u16(extra.length),
        name,
        extra,
      ]),
    );
    let crc = 0;
    if (data) {
      crc = crc32(data);
      await write(data);
    } else {
      for await (const chunk of createReadStream(entry.file!, { highWaterMark: 1 << 20, signal })) {
        crc = crc32(chunk as Buffer, crc);
        await write(chunk as Buffer);
      }
    }
    await write(Buffer.concat([u32(0x08074b50), u32(crc), ...(zip64 ? [u64(size), u64(size)] : [u32(size), u32(size)])]));
    written.push({ name, crc, size, offset: headerOffset, time, date, zip64 });
  }

  const cdStart = offset;
  for (const item of written) {
    const bigSize = item.size >= MAX32;
    const bigOffset = item.offset >= MAX32;
    const fields = [...(bigSize ? [u64(item.size), u64(item.size)] : []), ...(bigOffset ? [u64(item.offset)] : [])];
    const extra = fields.length ? Buffer.concat([u16(0x0001), u16(fields.length * 8), ...fields]) : Buffer.alloc(0);
    await write(
      Buffer.concat([
        u32(0x02014b50),
        u16((3 << 8) | 45), // 由 Unix 生成
        u16(item.zip64 || fields.length ? 45 : 20),
        u16(0x0808),
        u16(0),
        u16(item.time),
        u16(item.date),
        u32(item.crc),
        u32(bigSize ? MAX32 : item.size),
        u32(bigSize ? MAX32 : item.size),
        u16(item.name.length),
        u16(extra.length),
        u16(0),
        u16(0),
        u16(0),
        u32((0o100644 << 16) >>> 0), // 普通文件，rw-r--r--
        u32(bigOffset ? MAX32 : item.offset),
        item.name,
        extra,
      ]),
    );
  }
  const cdSize = offset - cdStart;
  const count = written.length;
  if (count >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32) {
    const zip64End = offset;
    await write(
      Buffer.concat([u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(count), u64(count), u64(cdSize), u64(cdStart)]),
    );
    await write(Buffer.concat([u32(0x07064b50), u32(0), u64(zip64End), u32(1)]));
  }
  await write(
    Buffer.concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(Math.min(count, 0xffff)),
      u16(Math.min(count, 0xffff)),
      u32(Math.min(cdSize, MAX32)),
      u32(Math.min(cdStart, MAX32)),
      u16(0),
    ]),
  );
}
