// 资产库左侧栏：视图（全部、最近、收藏、已挑选、未归档、回收站）、文件夹树（可拖入素材）、标签、智能文件夹、存储用量
import { useMemo, useState, type ReactNode } from 'react';
import {
  Bookmark,
  ChevronRight,
  Clock,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Hash,
  Heart,
  HardDrive,
  Images,
  MoreHorizontal,
  Pencil,
  ThumbsUp,
  Trash2,
  X,
} from 'lucide-react';
import type { AssetFolder, AssetQuery, AssetTag, SavedSearch, StorageUsage } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { cx } from '../../lib/util.ts';
import { confirmDialog, promptDialog } from '../ConfirmDialog.tsx';
import { DRAG_TYPE } from './AssetGrid.tsx';
import { descendants, pickFolder } from './FolderPicker.tsx';

export type Scope =
  | { type: 'all' | 'recent' | 'favorite' | 'pick' | 'unfiled' | 'trash' }
  | { type: 'folder'; id: string }
  | { type: 'tag'; id: string }
  | { type: 'saved'; id: string }
  | { type: 'story'; id: string };

export function scopeQuery(scope: Scope, saved: SavedSearch[]): AssetQuery {
  switch (scope.type) {
    case 'recent':
      return { days: 7 };
    case 'favorite':
      return { favorite: true };
    case 'pick':
      return { flag: 'pick' };
    case 'unfiled':
      return { unfiled: true };
    case 'trash':
      return { trash: true };
    case 'folder':
      return { folder: scope.id };
    case 'tag':
      return { tag: scope.id };
    case 'story':
      return { storyId: scope.id };
    case 'saved':
      return saved.find((item) => item.id === scope.id)?.query ?? {};
    default:
      return {};
  }
}

export function sameScope(a: Scope, b: Scope): boolean {
  return a.type === b.type && ('id' in a ? a.id : '') === ('id' in b ? b.id : '');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function readDragged(event: React.DragEvent): string[] | null {
  try {
    const raw = event.dataTransfer.getData(DRAG_TYPE);
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}

function Item({
  icon,
  label,
  count,
  active,
  onClick,
  depth = 0,
  onDrop,
  actions,
  expander,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  depth?: number;
  onDrop?: (ids: string[]) => void;
  actions?: ReactNode;
  expander?: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={cx(
        'group flex items-center rounded-lg pr-1 text-[13px] transition',
        active ? 'bg-white/[0.08] text-fg' : 'text-fg-2 hover:bg-white/[0.04] hover:text-fg',
        over && 'bg-accent/15 ring-1 ring-accent',
      )}
      style={{ paddingLeft: 6 + depth * 14 }}
      onDragOver={
        onDrop
          ? (event) => {
              if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
              event.preventDefault();
              setOver(true);
            }
          : undefined
      }
      onDragLeave={() => setOver(false)}
      onDrop={
        onDrop
          ? (event) => {
              setOver(false);
              const ids = readDragged(event);
              if (ids?.length) {
                event.preventDefault();
                onDrop(ids);
              }
            }
          : undefined
      }
    >
      <span className="flex w-4 shrink-0 justify-center">{expander}</span>
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1 text-left">
        <span className="shrink-0 text-fg-3">{icon}</span>
        <span className="truncate">{label}</span>
        {count !== undefined && count > 0 && <span className="ml-auto text-[11px] text-fg-3 tabular-nums">{count}</span>}
      </button>
      {actions && <span className="flex opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">{actions}</span>}
    </div>
  );
}

function SmallButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button aria-label={label} title={label} onClick={(event) => { event.stopPropagation(); onClick(); }} className="rounded p-1 text-fg-3 hover:bg-white/10 hover:text-fg">
      {children}
    </button>
  );
}

export function LibrarySidebar({
  scope,
  onScope,
  folders,
  tags,
  saved,
  usage,
  onChanged,
  onMoved,
  onOpenStorage,
}: {
  scope: Scope;
  onScope: (scope: Scope) => void;
  folders: AssetFolder[];
  tags: AssetTag[];
  saved: SavedSearch[];
  usage: StorageUsage | null;
  /** 文件夹、标签、智能文件夹有变化：重新加载 */
  onChanged: () => void;
  /** 素材被拖进了文件夹 */
  onMoved: () => void;
  onOpenStorage: () => void;
}) {
  const toast = useStore((s) => s.toast);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const children = useMemo(() => {
    const map = new Map<string | null, AssetFolder[]>();
    for (const folder of folders) {
      const list = map.get(folder.parentId) ?? [];
      list.push(folder);
      map.set(folder.parentId, list);
    }
    return map;
  }, [folders]);

  async function createFolder(parentId: string | null) {
    const name = await promptDialog({ title: parentId ? '新建子文件夹' : '新建文件夹', placeholder: '例如：第一集 / 角色定妆', maxLength: 40, confirmText: '创建' });
    if (!name) return;
    try {
      const folder = await api.createFolder(name, parentId);
      if (parentId) setOpen((prev) => new Set(prev).add(parentId));
      onChanged();
      onScope({ type: 'folder', id: folder.id });
    } catch (error) {
      reportError(error);
    }
  }

  async function renameFolder(folder: AssetFolder) {
    const name = await promptDialog({ title: '重命名文件夹', value: folder.name, maxLength: 40, confirmText: '保存' });
    if (!name || name === folder.name) return;
    try {
      await api.updateFolder(folder.id, { name });
      onChanged();
    } catch (error) {
      reportError(error);
    }
  }

  async function removeFolder(folder: AssetFolder) {
    if (!(await confirmDialog({ title: `删除文件夹「${folder.name}」？`, message: '子文件夹一起删除；里面的素材不会删除，会回到"未归档"。', confirmText: '删除文件夹', danger: true }))) return;
    try {
      await api.deleteFolder(folder.id);
      if (scope.type === 'folder') onScope({ type: 'all' });
      onChanged();
      onMoved();
    } catch (error) {
      reportError(error);
    }
  }

  async function moveInto(folderId: string | null, ids: string[]) {
    try {
      const result = await api.batchAssets({ ids }, 'move', folderId);
      toast(`已移动 ${result.count} 个素材`, 'success');
      onChanged();
      onMoved();
    } catch (error) {
      reportError(error);
    }
  }

  async function moveFolder(folder: AssetFolder) {
    const target = await pickFolder({ title: `把「${folder.name}」移到…`, folders, exclude: descendants(folders, folder.id), rootLabel: '顶层' });
    if (target === undefined || target === folder.parentId) return;
    try {
      await api.updateFolder(folder.id, { parentId: target });
      if (target) setOpen((prev) => new Set(prev).add(target));
      onChanged();
    } catch (error) {
      reportError(error);
    }
  }

  function renderFolders(parentId: string | null, depth: number): ReactNode {
    return (children.get(parentId) ?? []).map((folder) => {
      const kids = children.get(folder.id) ?? [];
      const expanded = open.has(folder.id);
      const active = scope.type === 'folder' && scope.id === folder.id;
      return (
        <div key={folder.id}>
          <Item
            depth={depth}
            icon={active ? <FolderOpen className="size-4" /> : <Folder className="size-4" />}
            label={folder.name}
            count={folder.count}
            active={active}
            onClick={() => onScope({ type: 'folder', id: folder.id })}
            onDrop={(ids) => void moveInto(folder.id, ids)}
            expander={
              kids.length ? (
                <button
                  aria-label={expanded ? '收起' : '展开'}
                  onClick={() =>
                    setOpen((prev) => {
                      const next = new Set(prev);
                      if (next.has(folder.id)) next.delete(folder.id);
                      else next.add(folder.id);
                      return next;
                    })
                  }
                  className="text-fg-3 hover:text-fg"
                >
                  <ChevronRight className={cx('size-3.5 transition-transform', expanded && 'rotate-90')} />
                </button>
              ) : null
            }
            actions={
              <>
                {depth < 3 && (
                  <SmallButton label="新建子文件夹" onClick={() => void createFolder(folder.id)}>
                    <FolderPlus className="size-3.5" />
                  </SmallButton>
                )}
                <SmallButton label="重命名" onClick={() => void renameFolder(folder)}>
                  <Pencil className="size-3.5" />
                </SmallButton>
                <SmallButton label="移动到" onClick={() => void moveFolder(folder)}>
                  <FolderInput className="size-3.5" />
                </SmallButton>
                <SmallButton label="删除" onClick={() => void removeFolder(folder)}>
                  <Trash2 className="size-3.5" />
                </SmallButton>
              </>
            }
          />
          {expanded && renderFolders(folder.id, depth + 1)}
        </div>
      );
    });
  }

  const views: { scope: Scope; icon: ReactNode; label: string }[] = [
    { scope: { type: 'all' }, icon: <Images className="size-4" />, label: '全部素材' },
    { scope: { type: 'recent' }, icon: <Clock className="size-4" />, label: '最近 7 天' },
    { scope: { type: 'favorite' }, icon: <Heart className="size-4" />, label: '收藏' },
    { scope: { type: 'pick' }, icon: <ThumbsUp className="size-4" />, label: '已挑选' },
    { scope: { type: 'unfiled' }, icon: <MoreHorizontal className="size-4" />, label: '未归档' },
  ];

  return (
    <nav aria-label="资产库导航" className="flex flex-col gap-4 text-sm">
      <div className="space-y-0.5">
        {views.map((view) => (
          <Item
            key={view.scope.type}
            icon={view.icon}
            label={view.label}
            active={sameScope(scope, view.scope)}
            onClick={() => onScope(view.scope)}
            onDrop={view.scope.type === 'unfiled' ? (ids) => void moveInto(null, ids) : undefined}
          />
        ))}
        <Item icon={<Trash2 className="size-4" />} label="回收站" count={usage?.trash.count} active={scope.type === 'trash'} onClick={() => onScope({ type: 'trash' })} />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between px-1.5">
          <span className="text-[11px] font-medium tracking-wider text-fg-3 uppercase">文件夹</span>
          <SmallButton label="新建文件夹" onClick={() => void createFolder(null)}>
            <FolderPlus className="size-3.5" />
          </SmallButton>
        </div>
        {folders.length ? <div className="space-y-0.5">{renderFolders(null, 0)}</div> : <p className="px-2 text-xs text-fg-3">把素材拖到文件夹里整理，最多 4 层</p>}
      </div>

      {saved.length > 0 && (
        <div>
          <p className="mb-1 px-1.5 text-[11px] font-medium tracking-wider text-fg-3 uppercase">智能文件夹</p>
          <div className="space-y-0.5">
            {saved.map((item) => (
              <Item
                key={item.id}
                icon={<Bookmark className="size-4" />}
                label={item.name}
                active={scope.type === 'saved' && scope.id === item.id}
                onClick={() => onScope({ type: 'saved', id: item.id })}
                actions={
                  <SmallButton
                    label="删除智能文件夹"
                    onClick={async () => {
                      try {
                        await api.deleteSavedSearch(item.id);
                        if (scope.type === 'saved' && scope.id === item.id) onScope({ type: 'all' });
                        onChanged();
                      } catch (error) {
                        reportError(error);
                      }
                    }}
                  >
                    <X className="size-3.5" />
                  </SmallButton>
                }
              />
            ))}
          </div>
        </div>
      )}

      {tags.length > 0 && (
        <div>
          <p className="mb-1 px-1.5 text-[11px] font-medium tracking-wider text-fg-3 uppercase">标签</p>
          <div className="space-y-0.5">
            {tags.map((tag) => (
              <Item
                key={tag.id}
                icon={<Hash className="size-4" />}
                label={tag.name}
                count={tag.count}
                active={scope.type === 'tag' && scope.id === tag.id}
                onClick={() => onScope({ type: 'tag', id: tag.id })}
                actions={
                  <>
                    <SmallButton
                      label="重命名标签"
                      onClick={async () => {
                        const name = await promptDialog({ title: '重命名标签', value: tag.name, maxLength: 30, message: '改成已有的标签名时会合并两个标签。' });
                        if (!name || name === tag.name) return;
                        try {
                          await api.renameTag(tag.id, name);
                          onChanged();
                        } catch (error) {
                          reportError(error);
                        }
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </SmallButton>
                    <SmallButton
                      label="删除标签"
                      onClick={async () => {
                        if (!(await confirmDialog({ title: `删除标签「${tag.name}」？`, message: '只删除标签本身，素材不受影响。', confirmText: '删除', danger: true }))) return;
                        try {
                          await api.deleteTag(tag.id);
                          if (scope.type === 'tag' && scope.id === tag.id) onScope({ type: 'all' });
                          onChanged();
                        } catch (error) {
                          reportError(error);
                        }
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </SmallButton>
                  </>
                }
              />
            ))}
          </div>
        </div>
      )}

      {usage && (
        <button onClick={onOpenStorage} className="rounded-lg border border-line p-2.5 text-left text-xs text-fg-3 transition hover:border-line-strong hover:text-fg-2">
          <span className="flex items-center gap-1.5 text-fg-2">
            <HardDrive className="size-3.5" /> 存储 {formatBytes(usage.total.bytes)} · {usage.total.count} 个
          </span>
          {usage.disk && (
            <span className="mt-2 block h-1 overflow-hidden rounded-full bg-white/[0.08]">
              <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (1 - usage.disk.free / usage.disk.total) * 100)}%` }} />
            </span>
          )}
          {usage.disk && <span className="mt-1.5 block">磁盘剩余 {formatBytes(usage.disk.free)}</span>}
          {usage.duplicates.groups > 0 && <span className="mt-1 block text-warn">{usage.duplicates.groups} 组重复文件，可省 {formatBytes(usage.duplicates.wasted)}</span>}
        </button>
      )}
    </nav>
  );
}
