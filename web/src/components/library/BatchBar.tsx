// 多选后的底部浮动操作条：收藏、评分、挑选/淘汰、移动到文件夹、加标签、打包下载、移入回收站（回收站里：恢复、彻底删除）
import { useState } from 'react';
import { Download, Folder, Hash, Heart, Star, ThumbsDown, ThumbsUp, Trash2, Undo2, X } from 'lucide-react';
import type { AssetFolder, AssetQuery } from '../../../../shared/types.ts';
import { api, type BatchAction } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { cx } from '../../lib/util.ts';
import { confirmDialog, promptDialog } from '../ConfirmDialog.tsx';
import { pickFolder } from './FolderPicker.tsx';
import { formatBytes } from './LibrarySidebar.tsx';

function BarButton({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cx('flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-2 py-1 text-[11px] transition hover:bg-white/[0.08]', danger ? 'text-danger' : 'text-fg-2 hover:text-fg')}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

export function BatchBar({
  ids,
  allMatching,
  query,
  total,
  trash,
  folders,
  onSelectAll,
  onClear,
  onDone,
}: {
  ids: string[];
  /** 已切换为"选中当前条件下的全部" */
  allMatching: boolean;
  query: AssetQuery;
  total: number | null;
  trash: boolean;
  folders: AssetFolder[];
  onSelectAll: () => void;
  onClear: () => void;
  /** 操作完成：changed=true 时需要刷新列表 */
  onDone: (changed: boolean) => void;
}) {
  const toast = useStore((s) => s.toast);
  const [rating, setRating] = useState(false);
  const count = allMatching ? (total ?? ids.length) : ids.length;
  const target = allMatching ? { query } : { ids };

  async function run(action: BatchAction, value?: unknown, refresh = false) {
    try {
      const result = await api.batchAssets(target, action, value);
      if (result.blocked.length) toast(`${result.count} 个已处理，${result.blocked.length} 个正在被任务使用，已跳过`, 'info');
      else toast(`已处理 ${result.count} 个素材`, 'success');
      onDone(refresh);
    } catch (error) {
      reportError(error);
    }
  }

  async function download() {
    try {
      const result = await api.exportAssets(target);
      toast(`正在打包 ${result.count} 个素材（${formatBytes(result.bytes)}）`, 'info');
      const link = document.createElement('a');
      link.href = result.url;
      link.click();
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(80px+env(safe-area-inset-bottom))] z-40 flex justify-center px-3 md:bottom-6 md:pl-[76px] lg:pl-56">
      <div role="toolbar" aria-label="批量操作" className="glass pointer-events-auto flex max-w-full flex-col gap-1 rounded-2xl border border-line-strong p-1.5 shadow-2xl">
        <div className="flex items-center gap-2 px-2 pt-0.5 text-xs text-fg-2">
          <span className="font-medium text-fg">已选 {count} 个</span>
          {!allMatching && total !== null && total > ids.length && (
            <button onClick={onSelectAll} className="text-accent hover:underline">
              选中当前条件下全部 {total} 个
            </button>
          )}
          <button onClick={onClear} aria-label="退出多选" className="ml-auto rounded p-0.5 text-fg-3 hover:text-fg">
            <X className="size-3.5" />
          </button>
        </div>
        <div className="no-scrollbar flex items-center gap-0.5 overflow-x-auto">
          {trash ? (
            <>
              <BarButton label="恢复" onClick={() => void run('restore', undefined, true)}>
                <Undo2 className="size-4" />
              </BarButton>
              <BarButton
                label="彻底删除"
                danger
                onClick={async () => {
                  if (!(await confirmDialog({ title: `彻底删除 ${count} 个素材？`, message: '文件会从硬盘上删除，无法恢复。', confirmText: '彻底删除', danger: true }))) return;
                  void run('purge', undefined, true);
                }}
              >
                <Trash2 className="size-4" />
              </BarButton>
            </>
          ) : (
            <>
              <BarButton label="收藏" onClick={() => void run('favorite', true)}>
                <Heart className="size-4" />
              </BarButton>
              <div className="relative">
                <BarButton label="评分" onClick={() => setRating((v) => !v)}>
                  <Star className="size-4" />
                </BarButton>
                {rating && (
                  <div className="glass absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 gap-0.5 rounded-xl border border-line-strong p-1">
                    {[0, 1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        onClick={() => {
                          setRating(false);
                          void run('rating', n);
                        }}
                        className="rounded-lg px-2 py-1 text-xs hover:bg-white/10"
                      >
                        {n === 0 ? '清除' : `${n}★`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <BarButton label="挑选" onClick={() => void run('flag', 'pick')}>
                <ThumbsUp className="size-4" />
              </BarButton>
              <BarButton label="淘汰" onClick={() => void run('flag', 'reject')}>
                <ThumbsDown className="size-4" />
              </BarButton>
              <BarButton
                label="移动到"
                onClick={async () => {
                  const folderId = await pickFolder({ title: `把 ${count} 个素材移到…`, folders });
                  if (folderId !== undefined) void run('move', folderId, true);
                }}
              >
                <Folder className="size-4" />
              </BarButton>
              <BarButton
                label="加标签"
                onClick={async () => {
                  const text = await promptDialog({ title: `给 ${count} 个素材加标签`, placeholder: '多个标签用空格或逗号分隔', maxLength: 120, confirmText: '添加' });
                  const names = text?.split(/[\s,，]+/).filter(Boolean) ?? [];
                  if (names.length) void run('addTags', names.slice(0, 20), true);
                }}
              >
                <Hash className="size-4" />
              </BarButton>
              <BarButton label="打包下载" onClick={() => void download()}>
                <Download className="size-4" />
              </BarButton>
              <BarButton
                label="回收站"
                danger
                onClick={async () => {
                  if (!(await confirmDialog({ title: `把 ${count} 个素材移入回收站？`, message: '30 天内可以在回收站里恢复。正在被任务使用的素材会被跳过。', confirmText: '移入回收站' }))) return;
                  void run('trash', undefined, true);
                }}
              >
                <Trash2 className="size-4" />
              </BarButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
