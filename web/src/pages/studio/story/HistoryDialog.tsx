import { useEffect, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import type { Story, StorySnapshot } from '../../../../../shared/types.ts';
import { Button, Empty, Modal, Spinner } from '../../../components/ui.tsx';
import { api } from '../../../lib/api.ts';
import { reportError } from '../../../lib/store.ts';

const REASON: Record<string, string> = {
  daily: '每日自动保存',
  restore: '恢复前的版本',
  'ai:outline': 'AI 生成大纲前',
  'ai:characters': 'AI 生成角色前',
  'ai:chapters': 'AI 拆分章节前',
  'ai:dialogue': 'AI 写台词前',
  'ai:shots': 'AI 设计分镜前',
};

function formatTime(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 历史版本：列出自动快照，可以恢复到任意一个（恢复前会再存一份当前版本） */
export function HistoryDialog({
  storyId,
  open,
  onClose,
  onRestored,
  beforeRestore,
}: {
  storyId: string;
  open: boolean;
  onClose: () => void;
  onRestored: (story: Story) => void;
  /** 恢复前先把本地未保存的修改存上去，保证“恢复前的版本”是最新的 */
  beforeRestore: () => Promise<boolean>;
}) {
  const [items, setItems] = useState<StorySnapshot[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setItems(null);
    api.storySnapshots(storyId).then(setItems, (error) => {
      reportError(error);
      setItems([]);
    });
  }, [open, storyId]);

  async function restore(item: StorySnapshot) {
    if (!window.confirm(`恢复到「${formatTime(item.createdAt)}」的版本？当前内容会先另存一份，可以再恢复回来。`)) return;
    setBusy(item.id);
    try {
      if (!(await beforeRestore())) return;
      onRestored(await api.restoreSnapshot(storyId, item.id));
      onClose();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="历史版本">
      {items === null ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <Empty icon={<History className="size-5" />} title="还没有历史版本" hint="每天第一次保存、以及 AI 改写内容之前，都会自动留一份" />
      ) : (
        <ul className="-mx-2 divide-y divide-line">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-2 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm">{formatTime(item.createdAt)}</p>
                <p className="truncate text-xs text-fg-3">
                  {REASON[item.reason] ?? item.reason} · {item.title}
                </p>
              </div>
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void restore(item)}>
                <RotateCcw className="size-3.5" /> 恢复
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
