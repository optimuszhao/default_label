// 分片上传：5 MB 一片按顺序发送，断网或刷新后用同一个上传编号从断点继续；相同文件服务端自动去重。
import type { Asset } from '../../../shared/types.ts';
import { ApiError, request } from './api.ts';

const RESUME_KEY = 'weave:uploads';

interface Pending {
  id: string;
  name: string;
  size: number;
  lastModified: number;
}

function fileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function readPending(): Record<string, Pending> {
  try {
    return JSON.parse(localStorage.getItem(RESUME_KEY) ?? '{}') as Record<string, Pending>;
  } catch {
    return {};
  }
}

function writePending(map: Record<string, Pending>): void {
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify(map));
  } catch {
    // 隐私模式等情况下写不进去：只是不能跨刷新续传
  }
}

/** 浏览器给的类型有时为空或不标准（例如 .m4a、.mov），按扩展名补上 */
export function mimeOf(file: File): string {
  if (file.type && file.type !== 'application/octet-stream') return file.type === 'audio/x-m4a' ? 'audio/mp4' : file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
  };
  return map[ext] ?? file.type;
}

export const ACCEPT_MEDIA = 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,audio/*,.m4a,.mov';

export interface UploadOptions {
  folderId?: string | null;
  storyId?: string | null;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface UploadResult {
  asset: Asset;
  duplicate: boolean;
}

async function putChunk(id: string, offset: number, blob: Blob, signal?: AbortSignal): Promise<number> {
  const response = await fetch(`/api/uploads/${id}?offset=${offset}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: blob,
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as { received?: number; error?: string };
  // 顺序对不上（另一个标签页或上次中断时已经多收了一些）：按服务端的进度继续
  if (response.status === 409 && typeof data.received === 'number') return data.received;
  if (!response.ok) throw new ApiError(response.status, data.error ?? `上传失败（${response.status}）`);
  return data.received ?? offset + blob.size;
}

export async function uploadFile(file: File, options: UploadOptions = {}): Promise<UploadResult> {
  const key = fileKey(file);
  const pending = readPending();
  let session: { id: string; chunkSize: number; received: number } | null = null;
  const saved = pending[key];
  if (saved) {
    try {
      session = await request('GET', `/api/uploads/${saved.id}`);
    } catch {
      session = null;
    }
  }
  if (!session) {
    session = await request('POST', '/api/uploads', { filename: file.name, mime: mimeOf(file), size: file.size });
    pending[key] = { id: session!.id, name: file.name, size: file.size, lastModified: file.lastModified };
    writePending(pending);
  }
  const { id, chunkSize } = session!;
  let offset = session!.received;
  options.onProgress?.(file.size ? offset / file.size : 0);
  let failures = 0;
  while (offset < file.size) {
    try {
      offset = await putChunk(id, offset, file.slice(offset, offset + chunkSize), options.signal);
      failures = 0;
      options.onProgress?.(offset / file.size);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // 网络抖动：最多重试 5 次，间隔逐渐加长
      if (++failures > 5 || (error instanceof ApiError && error.status < 500 && error.status !== 0)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * failures));
      try {
        offset = (await request<{ received: number }>('GET', `/api/uploads/${id}`)).received;
      } catch {
        // 查询也失败：保持原来的偏移重试
      }
    }
  }
  const result = await request<UploadResult>('POST', `/api/uploads/${id}/complete`, { folderId: options.folderId ?? null, storyId: options.storyId ?? null });
  const map = readPending();
  delete map[key];
  writePending(map);
  return result;
}
