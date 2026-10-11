// 读 zip（导入故事包用）：解析中央目录，支持 stored / deflate 两种方式和 zip64；按条目流式解出到文件或读进内存。
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

export interface ZipIndexEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const MAX_ENTRIES = 20_000;

export async function readZipIndex(file: string): Promise<ZipIndexEntry[]> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const tailSize = Math.min(size, 65_557 + 20);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    // zip64：EOCD 前面有定位器，指向 zip64 EOCD 记录
    if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50) {
      const recordOffset = Number(tail.readBigUInt64LE(eocd - 12));
      const record = Buffer.alloc(56);
      await handle.read(record, 0, 56, recordOffset);
      if (record.readUInt32LE(0) === 0x06064b50) {
        count = Number(record.readBigUInt64LE(32));
        cdSize = Number(record.readBigUInt64LE(40));
        cdOffset = Number(record.readBigUInt64LE(48));
      }
    }
    if (count > MAX_ENTRIES) throw new Error('压缩包里的文件太多');
    if (cdOffset + cdSize > size) throw new Error('zip 文件不完整');
    const cd = Buffer.alloc(cdSize);
    await handle.read(cd, 0, cdSize, cdOffset);
    const entries: ZipIndexEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏');
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let entrySize = cd.readUInt32LE(p + 24);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLength).toString('utf8');
      // zip64 扩展字段：按顺序只出现那些值为 0xFFFFFFFF 的字段
      let e = p + 46 + nameLength;
      const extraEnd = e + extraLength;
      while (e + 4 <= extraEnd) {
        const id = cd.readUInt16LE(e);
        const length = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (entrySize === 0xffffffff) (entrySize = Number(cd.readBigUInt64LE(q)), (q += 8));
          if (compressedSize === 0xffffffff) (compressedSize = Number(cd.readBigUInt64LE(q)), (q += 8));
          if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
        }
        e += 4 + length;
      }
      entries.push({ name, method, compressedSize, size: entrySize, offset });
      p = extraEnd + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function dataStart(file: string, entry: ZipIndexEntry): Promise<number> {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.offset);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`zip 条目损坏：${entry.name}`);
    return entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
}

function source(file: string, entry: ZipIndexEntry, start: number) {
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`不支持的压缩方式：${entry.name}`);
  if (entry.compressedSize === 0) return null;
  return createReadStream(file, { start, end: start + entry.compressedSize - 1 });
}

export async function extractEntry(file: string, entry: ZipIndexEntry, target: string): Promise<void> {
  const start = await dataStart(file, entry);
  const input = source(file, entry, start);
  if (!input) return fs.writeFile(target, '');
  if (entry.method === 8) await pipeline(input, zlib.createInflateRaw(), createWriteStream(target));
  else await pipeline(input, createWriteStream(target));
}

export async function readEntry(file: string, entry: ZipIndexEntry, maxBytes = 50 * 1024 * 1024): Promise<Buffer> {
  if (entry.size > maxBytes) throw new Error(`${entry.name} 太大`);
  const start = await dataStart(file, entry);
  const input = source(file, entry, start);
  if (!input) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  return entry.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: maxBytes }) : raw;
}
