// 存储统计与清理：按类型、月份、故事统计占用；合并重复文件；清空回收站
import { useEffect, useState } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import type { Asset, StorageUsage } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { confirmDialog } from '../ConfirmDialog.tsx';
import { Button, Media, Modal, Spinner } from '../ui.tsx';
import { formatBytes } from './LibrarySidebar.tsx';

const KIND_LABEL: Record<string, string> = { image: '图片', video: '视频', audio: '音频' };

function Bars({ rows, total }: { rows: { label: string; bytes: number; count: number }[]; total: number }) {
  return (
    <ul className="space-y-1.5">
      {rows.map((row) => (
        <li key={row.label} className="text-xs">
          <div className="flex justify-between text-fg-2">
            <span className="truncate">{row.label}</span>
            <span className="shrink-0 tabular-nums text-fg-3">
              {formatBytes(row.bytes)} · {row.count}
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-accent" style={{ width: `${total ? Math.max(1, (row.bytes / total) * 100) : 0}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function StorageDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [dups, setDups] = useState<{ sha256: string; keepId: string; assets: Asset[] }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);

  async function load() {
    try {
      const [u, d] = await Promise.all([api.storageUsage(), api.duplicates()]);
      setUsage(u);
      setDups(d);
    } catch (error) {
      reportError(error);
    }
  }

  useEffect(() => {
    if (open) void load();
  }, [open]);

  async function merge() {
    if (!(await confirmDialog({ title: '合并全部重复文件？', message: '每组只保留一份（优先保留有评分、收藏或被故事使用的），其余的引用改指向保留的那份，然后彻底删除。', confirmText: '合并' }))) return;
    setBusy(true);
    try {
      const result = await api.mergeDuplicates();
      toast(`已合并 ${result.groups} 组，删除 ${result.removed} 个重复文件`, 'success');
      onChanged();
      await load();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  async function emptyTrash() {
    if (!usage?.trash.count) return;
    if (!(await confirmDialog({ title: `清空回收站（${usage.trash.count} 个）？`, message: `释放 ${formatBytes(usage.trash.bytes)}。文件会从硬盘上删除，无法恢复。`, confirmText: '清空', danger: true }))) return;
    setBusy(true);
    try {
      await api.emptyTrash();
      onChanged();
      await load();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="存储与清理" wide>
      {!usage ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['素材', `${usage.total.count} 个`],
              ['占用', formatBytes(usage.total.bytes)],
              ['回收站', `${usage.trash.count} 个 · ${formatBytes(usage.trash.bytes)}`],
              ['磁盘剩余', usage.disk ? formatBytes(usage.disk.free) : '未知'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-line p-3">
                <p className="text-xs text-fg-3">{label}</p>
                <p className="mt-1 text-sm font-medium">{value}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-6 sm:grid-cols-3">
            <div>
              <p className="label">按类型</p>
              <Bars rows={usage.byKind.map((row) => ({ label: KIND_LABEL[row.kind] ?? row.kind, bytes: row.bytes, count: row.count }))} total={usage.total.bytes} />
            </div>
            <div>
              <p className="label">按月份</p>
              <Bars rows={usage.byMonth.slice(0, 8).map((row) => ({ label: row.month, bytes: row.bytes, count: row.count }))} total={usage.total.bytes} />
            </div>
            <div>
              <p className="label">按故事</p>
              <Bars rows={usage.byStory.slice(0, 8).map((row) => ({ label: row.title, bytes: row.bytes, count: row.count }))} total={usage.total.bytes} />
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="label !mb-0">
                重复文件{dups?.length ? `（${dups.length} 组，可省 ${formatBytes(usage.duplicates.wasted)}）` : ''}
              </p>
              {dups && dups.length > 0 && (
                <Button size="sm" variant="secondary" icon={<Copy className="size-3.5" />} loading={busy} onClick={() => void merge()}>
                  合并全部
                </Button>
              )}
            </div>
            {!dups ? (
              <Spinner />
            ) : dups.length === 0 ? (
              <p className="text-sm text-fg-3">没有重复文件。</p>
            ) : (
              <ul className="max-h-60 space-y-2 overflow-y-auto">
                {dups.slice(0, 30).map((group) => (
                  <li key={group.sha256} className="flex items-center gap-2">
                    {group.assets.slice(0, 6).map((asset) => (
                      <div key={asset.id} className={`size-12 shrink-0 overflow-hidden rounded-md border ${asset.id === group.keepId ? 'border-ok' : 'border-line opacity-60'}`}>
                        <Media asset={asset} variant="thumb" />
                      </div>
                    ))}
                    <span className="text-xs text-fg-3">
                      {group.assets.length} 份 · {formatBytes(group.assets[0].size ?? 0)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex justify-end">
            <Button variant="danger" size="sm" icon={<Trash2 className="size-3.5" />} disabled={!usage.trash.count} loading={busy} onClick={() => void emptyTrash()}>
              清空回收站
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
