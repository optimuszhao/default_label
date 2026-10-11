import { useEffect, useState } from 'react';
import { ArrowLeft, Bookmark, Eye, History, Pin, RotateCcw } from 'lucide-react';
import type { Story, StoryData, StorySnapshot } from '../../../../../shared/types.ts';
import { Button, Empty, Modal, Spinner } from '../../../components/ui.tsx';
import { api } from '../../../lib/api.ts';
import { reportError, useStore } from '../../../lib/store.ts';
import { confirmDialog, promptDialog } from '../../../components/ConfirmDialog.tsx';

const REASON: Record<string, string> = {
  daily: '每日自动保存',
  auto: '自动保存',
  manual: '手动保存',
  migration: '升级前的原始内容',
  restore: '恢复前的版本',
  before_restore: '恢复前的版本',
  before_batch: '批量生成前',
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

function countOf(data: StoryData) {
  let scenes = 0;
  let shots = 0;
  for (const chapter of data.chapters ?? []) {
    scenes += chapter.scenes?.length ?? 0;
    for (const scene of chapter.scenes ?? []) shots += scene.shots?.length ?? 0;
  }
  return { chapters: data.chapters?.length ?? 0, scenes, shots, characters: data.characters?.length ?? 0 };
}

/** 只读预览一个历史版本：设定、大纲、章节场次、角色 */
function Preview({ snapshot, onBack, onRestore, busy }: { snapshot: StorySnapshot & { data: StoryData }; onBack: () => void; onRestore: () => void; busy: boolean }) {
  const data = snapshot.data;
  const counts = countOf(data);
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button onClick={onBack} className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
          <ArrowLeft className="size-3.5" /> 返回列表
        </button>
        <span className="flex-1" />
        <Button size="sm" variant="brand" loading={busy} onClick={onRestore}>
          <RotateCcw className="size-3.5" /> 恢复到这个版本
        </Button>
      </div>
      <p className="text-sm font-medium">{snapshot.title}</p>
      <p className="mt-0.5 text-xs text-fg-3">
        {formatTime(snapshot.createdAt)} · {counts.chapters} 章 · {counts.scenes} 场 · {counts.shots} 镜 · {counts.characters} 个角色
      </p>
      <div className="mt-3 max-h-[50dvh] space-y-3 overflow-y-auto rounded-lg border border-line p-3 text-[13px]">
        {data.logline && <p className="text-fg-2">{data.logline}</p>}
        {data.outline && <p className="line-clamp-6 whitespace-pre-wrap text-fg-3">{data.outline}</p>}
        {data.characters?.length > 0 && <p className="text-fg-3">角色：{data.characters.map((c) => c.name).join('、')}</p>}
        <ol className="space-y-1.5">
          {(data.chapters ?? []).map((chapter, i) => (
            <li key={chapter.id}>
              <p className="text-fg-2">
                第 {i + 1} 章 · {chapter.title || '未命名'}
              </p>
              <ul className="mt-0.5 ml-4 list-disc text-fg-3">
                {(chapter.scenes ?? []).map((scene) => (
                  <li key={scene.id}>
                    {scene.title || '未命名场次'}（{scene.shots?.length ?? 0} 镜）
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** 历史版本：自动、手动、AI 改写前、恢复前的快照，可预览、恢复（恢复前会再存一份当前版本） */
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
  const [preview, setPreview] = useState<(StorySnapshot & { data: StoryData }) | null>(null);
  const toast = useStore((s) => s.toast);

  async function load() {
    try {
      setItems(await api.storySnapshots(storyId));
    } catch (error) {
      reportError(error);
      setItems([]);
    }
  }

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setPreview(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, storyId]);

  async function restore(item: StorySnapshot) {
    if (!(await confirmDialog({ title: `恢复到「${formatTime(item.createdAt)}」的版本？`, message: '当前内容会先另存一份，可以再恢复回来。', confirmText: '恢复' }))) return;
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

  async function saveNow() {
    const label = await promptDialog({ title: '保存当前版本', message: '手动保存的版本会永久保留。', placeholder: '例如：第一集定稿', maxLength: 60, confirmText: '保存' });
    if (label === null) return;
    setBusy('save');
    try {
      await beforeRestore();
      await api.saveSnapshot(storyId, label);
      toast('已保存当前版本', 'success');
      await load();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }

  async function open_(item: StorySnapshot) {
    setBusy(item.id);
    try {
      setPreview(await api.storySnapshot(storyId, item.id));
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="历史版本">
      {preview ? (
        <Preview snapshot={preview} onBack={() => setPreview(null)} onRestore={() => void restore(preview)} busy={busy === preview.id} />
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-xs text-fg-3">7 天内的全部保留，90 天内每天留 1 份，更早的每周留 1 份；手动保存的永久保留。</p>
            <Button size="sm" variant="secondary" loading={busy === 'save'} onClick={() => void saveNow()}>
              <Bookmark className="size-3.5" /> 保存当前版本
            </Button>
          </div>
          {items === null ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : items.length === 0 ? (
            <Empty icon={<History className="size-5" />} title="还没有历史版本" hint="每天第一次保存、AI 改写和批量生成之前，都会自动留一份" />
          ) : (
            <ul className="-mx-2 max-h-[60dvh] divide-y divide-line overflow-y-auto">
              {items.map((item) => (
                <li key={item.id} className="flex items-center gap-2 px-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-sm">
                      {formatTime(item.createdAt)}
                      {item.pinned && <Pin className="size-3 text-accent" />}
                      {item.label && <span className="truncate text-accent">{item.label}</span>}
                    </p>
                    <p className="truncate text-xs text-fg-3">
                      {REASON[item.reason] ?? item.reason} · {item.title}
                      {item.stats ? ` · ${item.stats.chapters} 章 ${item.stats.shots} 镜` : ''}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void open_(item)}>
                    <Eye className="size-3.5" /> 查看
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void restore(item)}>
                    <RotateCcw className="size-3.5" /> 恢复
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}
