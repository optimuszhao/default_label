// 故事编辑器的保存与同步：
//   - 编辑后 600 ms 把"上次已提交的版本 → 当前版本"的差异算成 ops，先写进本地队列（localStorage），再发给服务器
//   - 断网、关页面时队列留在本地，下次打开先在界面上重放，再补发（服务器按批次编号去重）
//   - 其他设备的修改通过 SSE 得知，拉取 ops 应用到当前内容上（本地未提交的修改保留）
//   - 撤销 / 重做：切回上一版内容，差异照常提交
import { useCallback, useEffect, useRef, useState } from 'react';
import { applyStoryOps, diffStory, type SortKeys, type StoryOp } from '../../../../../shared/story-ops.ts';
import type { ServerEvent, Story, StoryData } from '../../../../../shared/types.ts';
import { api, ApiError } from '../../../lib/api.ts';
import { reportError, useStore } from '../../../lib/store.ts';
import { uid } from '../../../lib/util.ts';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'readonly';

interface Batch {
  batchId: string;
  baseRev: number;
  ops: StoryOp[];
}

interface Content {
  title: string;
  data: StoryData;
}

const QUEUE_KEY = (id: string) => `weave:story-queue:${id}`;
const UNDO_LIMIT = 200;
/** keepalive 请求体超过 64 KB 会被浏览器拒绝 */
const KEEPALIVE_LIMIT = 60_000;

function readQueue(id: string): Batch[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY(id)) ?? '[]') as Batch[];
  } catch {
    return [];
  }
}

function writeQueue(id: string, queue: Batch[]): void {
  try {
    if (queue.length) localStorage.setItem(QUEUE_KEY(id), JSON.stringify(queue));
    else localStorage.removeItem(QUEUE_KEY(id));
  } catch {
    // 本地存储满了或被禁用：只是不能断网重放
  }
}

export function useStorySync(id: string) {
  const [content, setContent] = useState<Content | null>(null);
  const [save, setSave] = useState<SaveState>('saved');
  const [readOnly, setReadOnly] = useState<string | null>(null);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const toast = useStore((s) => s.toast);
  const clientId = useRef(uid('cl_'));
  const latest = useRef<Content | null>(null);
  /** 已写进队列（或已提交）的版本：下一次差异从这里算 */
  const committed = useRef<Content | null>(null);
  const keys = useRef<SortKeys>(new Map());
  const rev = useRef(0);
  const sending = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoStack = useRef<Content[]>([]);
  const redoStack = useRef<Content[]>([]);
  const lastPush = useRef(0);
  const failures = useRef(0);

  const syncHistory = () => setHistory({ undo: undoStack.current.length, redo: redoStack.current.length });

  /** 把队列里的批次按顺序发出去 */
  const send = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      for (;;) {
        const queue = readQueue(id);
        if (!queue.length) break;
        setSave('saving');
        const batch = queue[0];
        const result = await api.storyOps(id, { baseRev: batch.baseRev, clientId: clientId.current, batchId: batch.batchId, ops: batch.ops });
        if (!result.duplicate) rev.current = Math.max(rev.current, result.rev);
        writeQueue(id, readQueue(id).filter((item) => item.batchId !== batch.batchId));
        failures.current = 0;
      }
      setSave(latest.current === committed.current ? 'saved' : 'dirty');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setReadOnly(error.message);
        setSave('readonly');
      } else if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        // 服务器拒绝了这批修改（数据不合法）：丢掉，避免一直重试
        writeQueue(id, readQueue(id).slice(1));
        reportError(error);
        setSave('error');
      } else {
        setSave('error');
        // 断网：逐渐拉长间隔重试（3、6、12……最多 30 秒）
        failures.current++;
        if (retry.current) clearTimeout(retry.current);
        retry.current = setTimeout(() => void send(), Math.min(30_000, 3000 * 2 ** (failures.current - 1)));
      }
    } finally {
      sending.current = false;
    }
  }, [id]);

  /** 当前内容和上次提交之间的差异写进队列，然后发送 */
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const now = latest.current;
    const base = committed.current;
    if (!now || !base || now === base) return void send();
    const ops = diffStory(base, now, keys.current);
    committed.current = now;
    if (ops.length) writeQueue(id, [...readQueue(id), { batchId: uid('b_'), baseRev: rev.current, ops }]);
    void send();
  }, [id, send]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  }, [flush]);

  const replace = useCallback((next: Content) => {
    latest.current = next;
    setContent(next);
  }, []);

  /** 载入（或重新载入）整篇；本地队列里没发出去的修改在界面上重放 */
  const load = useCallback(async (): Promise<Story | null> => {
    const story = await api.story(id);
    keys.current = new Map(Object.entries(story.keys ?? {}));
    rev.current = story.rev;
    let next: Content = { title: story.title, data: story.data };
    committed.current = next;
    if (story.readOnly) {
      setReadOnly('这个故事升级到新格式时出了问题，暂时只能查看。原内容已完整保留，请联系开发者处理。');
      setSave('readonly');
      replace(next);
      return story;
    }
    const queue = readQueue(id);
    if (queue.length) {
      for (const batch of queue) next = applyStoryOps(next, batch.ops, keys.current);
      committed.current = next;
      toast('已恢复上次未保存的修改', 'info');
    }
    replace(next);
    undoStack.current = [];
    redoStack.current = [];
    syncHistory();
    setSave(queue.length ? 'dirty' : 'saved');
    if (queue.length) void send();
    return story;
  }, [id, replace, send, toast]);

  /** 编辑：recipe 基于最新内容生成新内容 */
  const update = useCallback(
    (recipe: (data: StoryData) => StoryData) => {
      const prev = latest.current;
      if (!prev || readOnly) return;
      const next = { title: prev.title, data: recipe(prev.data) };
      if (next.data === prev.data) return;
      // 连续输入合并成一步撤销
      if (Date.now() - lastPush.current > 1000) {
        undoStack.current = [...undoStack.current.slice(-(UNDO_LIMIT - 1)), prev];
        redoStack.current = [];
        syncHistory();
      }
      lastPush.current = Date.now();
      replace(next);
      setSave('dirty');
      schedule();
    },
    [readOnly, replace, schedule],
  );

  const setTitle = useCallback(
    (title: string) => {
      const prev = latest.current;
      if (!prev || readOnly) return;
      if (Date.now() - lastPush.current > 1000) {
        undoStack.current = [...undoStack.current.slice(-(UNDO_LIMIT - 1)), prev];
        redoStack.current = [];
        syncHistory();
      }
      lastPush.current = Date.now();
      replace({ ...prev, title });
      setSave('dirty');
      schedule();
    },
    [readOnly, replace, schedule],
  );

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev || !latest.current) return;
    redoStack.current.push(latest.current);
    lastPush.current = 0;
    replace(prev);
    syncHistory();
    setSave('dirty');
    schedule();
  }, [replace, schedule]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next || !latest.current) return;
    undoStack.current.push(latest.current);
    lastPush.current = 0;
    replace(next);
    syncHistory();
    setSave('dirty');
    schedule();
  }, [replace, schedule]);

  /** 其他设备改了这篇故事：拉取 ops 应用到已提交版本和当前版本上 */
  const pull = useCallback(async () => {
    try {
      const result = await api.storyChanges(id, rev.current);
      if (result.reset) {
        flush();
        await load();
        return;
      }
      const foreign = result.changes.filter((change) => change.clientId !== clientId.current);
      for (const change of result.changes) rev.current = Math.max(rev.current, change.rev);
      if (!foreign.length || !latest.current || !committed.current) return;
      const ops = foreign.flatMap((change) => change.ops);
      const local = latest.current === committed.current ? null : diffStory(committed.current, latest.current, new Map(keys.current));
      committed.current = applyStoryOps(committed.current, ops, keys.current);
      // 本地还没提交的修改叠在别人的修改之上
      const next = local ? applyStoryOps(committed.current, local, new Map(keys.current)) : committed.current;
      replace(next);
      // 撤销栈里的旧内容不含别人的修改，清掉以免撤销时把别人的修改也撤回
      undoStack.current = [];
      redoStack.current = [];
      syncHistory();
    } catch {
      // 拉取失败：下次事件再试
    }
  }, [id, flush, load, replace]);

  useEffect(() => {
    const onRev = (event: Event) => {
      const detail = (event as CustomEvent<Extract<ServerEvent, { type: 'story-rev' }>>).detail;
      if (detail.storyId !== id || detail.clientId === clientId.current || detail.rev <= rev.current) return;
      void pull();
    };
    window.addEventListener('weave:story-rev', onRev);
    return () => window.removeEventListener('weave:story-rev', onRev);
  }, [id, pull]);

  // 离开页面：未提交的差异写进队列，并用 keepalive 尽量发出去（没送达的下次打开时重放）
  useEffect(() => {
    const onHide = () => {
      if (latest.current && committed.current && latest.current !== committed.current) {
        const ops = diffStory(committed.current, latest.current, keys.current);
        committed.current = latest.current;
        if (ops.length) writeQueue(id, [...readQueue(id), { batchId: uid('b_'), baseRev: rev.current, ops }]);
      }
      for (const batch of readQueue(id)) {
        const body = JSON.stringify({ baseRev: batch.baseRev, clientId: clientId.current, batchId: batch.batchId, ops: batch.ops });
        if (body.length > KEEPALIVE_LIMIT) break;
        void fetch(`/api/stories/${id}/ops`, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body }).catch(() => undefined);
      }
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      onHide();
      if (timer.current) clearTimeout(timer.current);
      if (retry.current) clearTimeout(retry.current);
    };
  }, [id]);

  // 恢复联网时立刻补发
  useEffect(() => {
    const onOnline = () => void send();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [send]);

  return {
    content,
    save,
    readOnly,
    load,
    update,
    setTitle,
    undo,
    redo,
    canUndo: history.undo > 0,
    canRedo: history.redo > 0,
    /** 立即提交（恢复历史版本、AI 改写之前调用） */
    flushNow: async () => {
      flush();
      for (let i = 0; i < 100 && (sending.current || readQueue(id).length); i++) await new Promise((r) => setTimeout(r, 100));
      return readQueue(id).length === 0;
    },
    rev: () => rev.current,
  };
}
