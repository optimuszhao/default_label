// 故事的本地草稿：还没保存到服务器的修改先写进 localStorage，
// 断网、关页面、keepalive 请求过大时都不会丢，下次打开时重放。
import type { StoryData } from '../../../../../shared/types.ts';

export interface StoryDraft {
  /** 这份草稿基于服务器的哪个版本 */
  baseRev: number;
  title: string;
  data: StoryData;
  savedAt: number;
}

const key = (id: string) => `weave:story-draft:${id}`;

export function readDraft(id: string): StoryDraft | null {
  try {
    const raw = localStorage.getItem(key(id));
    if (!raw) return null;
    const draft = JSON.parse(raw) as StoryDraft;
    return draft && draft.data && typeof draft.baseRev === 'number' ? draft : null;
  } catch {
    return null;
  }
}

export function writeDraft(id: string, draft: StoryDraft): void {
  try {
    localStorage.setItem(key(id), JSON.stringify(draft));
  } catch {
    // 隐私模式或空间已满：只能依赖在线保存
  }
}

export function clearDraft(id: string): void {
  try {
    localStorage.removeItem(key(id));
  } catch {
    // 忽略
  }
}

/** 草稿和服务器内容是否真的不同（避免无意义的“恢复”提示） */
export function draftDiffers(draft: StoryDraft, title: string, data: StoryData): boolean {
  return draft.title !== title || JSON.stringify(draft.data) !== JSON.stringify(data);
}
