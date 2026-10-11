// 素材选择器 v2：复用资产库的虚拟网格，可搜索、按范围筛选（当前故事 / 全部 / 收藏 / 文件夹）、
// 无限滚动、多选，也可以直接上传（大文件分片上传）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Upload, X } from 'lucide-react';
import type { Asset, AssetFolder, AssetQuery, MediaKind } from '../../../shared/types.ts';
import { api } from '../lib/api.ts';
import { reportError, useStore } from '../lib/store.ts';
import { ACCEPT_MEDIA, uploadFile } from '../lib/upload.ts';
import { useDebouncedCallback } from '../lib/util.ts';
import { AssetGrid, type GridSelection } from './library/AssetGrid.tsx';
import { useLibrary } from './library/useLibrary.ts';
import { Button, Empty, Modal, Segmented, Spinner } from './ui.tsx';

/** 上传本地文件（分片、可续传）并写入全局资产缓存 */
export function useUpload(options: { storyId?: string | null; folderId?: string | null } = {}) {
  const upsertAssets = useStore((s) => s.upsertAssets);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  async function upload(files: FileList | File[]): Promise<Asset[]> {
    setUploading(true);
    setProgress(0);
    try {
      const list = Array.from(files);
      const results: Asset[] = [];
      for (const [index, file] of list.entries()) {
        const result = await uploadFile(file, {
          storyId: options.storyId,
          folderId: options.folderId,
          onProgress: (fraction) => setProgress((index + fraction) / list.length),
        });
        results.push(result.asset);
      }
      upsertAssets(results);
      return results;
    } catch (error) {
      reportError(error);
      return [];
    } finally {
      setUploading(false);
    }
  }
  return { upload, uploading, progress };
}

type Range = 'story' | 'all' | 'favorite' | 'folder';

const KIND_LABEL: Record<MediaKind, string> = { image: '图片', video: '视频', audio: '音频' };

export function AssetPicker({
  open,
  onClose,
  onPick,
  max = 1,
  title = '选择图片',
  kinds = ['image'],
  storyId,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (assets: Asset[]) => void;
  max?: number;
  title?: string;
  /** 可选的素材类型，默认只选图片 */
  kinds?: MediaKind[];
  /** 在故事里打开时，默认先显示这个故事的素材 */
  storyId?: string | null;
}) {
  const [range, setRange] = useState<Range>(storyId ? 'story' : 'all');
  const [kind, setKind] = useState<MediaKind>(kinds[0]);
  const [folder, setFolder] = useState<string>('');
  const [folders, setFolders] = useState<AssetFolder[]>([]);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [selection, setSelection] = useState<GridSelection>({ selected: new Set(), selecting: true });
  const assets = useStore((s) => s.assets);
  const { upload, uploading, progress } = useUpload({ storyId });
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const applySearch = useDebouncedCallback((value: string) => setQ(value.trim()), 300);
  const kindsKey = kinds.join(',');

  useEffect(() => {
    if (!open) return;
    setSelection({ selected: new Set(), selecting: true });
    setRange(storyId ? 'story' : 'all');
    setKind(kindsKey.split(',')[0] as MediaKind);
    void api.folders().then(setFolders).catch(() => undefined);
  }, [open, storyId, kindsKey]);

  const query = useMemo<AssetQuery>(
    () => ({
      kind,
      ...(q ? { q } : {}),
      ...(range === 'story' && storyId ? { storyId } : {}),
      ...(range === 'favorite' ? { favorite: true } : {}),
      ...(range === 'folder' && folder ? { folder } : {}),
    }),
    [kind, q, range, storyId, folder],
  );
  const library = useLibrary(query, { pageSize: 90, enabled: open });

  // 当前故事里还没有素材时自动切到全部
  useEffect(() => {
    if (open && range === 'story' && library.loaded && library.ids.length === 0 && !q) setRange('all');
  }, [open, range, library.loaded, library.ids.length, q]);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    const allowed = Array.from(files).filter((file) => kinds.some((k) => file.type.startsWith(`${k}/`) || (k === 'audio' && /\.(m4a|aac|flac)$/i.test(file.name))));
    if (!allowed.length) {
      useStore.getState().toast(`这里只能选${kinds.map((k) => KIND_LABEL[k]).join('或')}`, 'error');
      return;
    }
    const uploaded = await upload(allowed.slice(0, max));
    if (uploaded.length) {
      onPick(uploaded);
      onClose();
    }
  }

  const ordered = [...selection.selected];
  const accept = kinds.includes('audio') && kinds.length === 1 ? 'audio/*,.m4a' : ACCEPT_MEDIA;

  return (
    <Modal open={open} onClose={onClose} title={title} wide>
      <input ref={inputRef} type="file" accept={accept} multiple={max > 1} hidden onChange={(e) => void onFiles(e.target.files)} />
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-3" />
          <input
            className="field !h-8 !pl-8 text-[13px]"
            placeholder="搜索提示词、备注、标签"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              applySearch(e.target.value);
            }}
          />
          {search && (
            <button aria-label="清除搜索" onClick={() => { setSearch(''); setQ(''); }} className="absolute top-1/2 right-2 -translate-y-1/2 text-fg-3">
              <X className="size-3.5" />
            </button>
          )}
        </label>
        {kinds.length > 1 && (
          <Segmented size="sm" value={kind} onChange={setKind} options={kinds.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
        )}
        <Button
          size="sm"
          variant="secondary"
          icon={uploading ? <Spinner /> : <Upload className="size-4" />}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void onFiles(e.dataTransfer.files);
          }}
        >
          {uploading ? `上传中 ${Math.round(progress * 100)}%` : '上传'}
        </Button>
      </div>
      <div className="no-scrollbar mt-2 flex items-center gap-1.5 overflow-x-auto">
        {storyId && (
          <button className={`chip ${range === 'story' ? '!border-accent !text-fg' : ''}`} onClick={() => setRange('story')}>
            本故事
          </button>
        )}
        <button className={`chip ${range === 'all' ? '!border-accent !text-fg' : ''}`} onClick={() => setRange('all')}>
          全部
        </button>
        <button className={`chip ${range === 'favorite' ? '!border-accent !text-fg' : ''}`} onClick={() => setRange('favorite')}>
          收藏
        </button>
        {folders.length > 0 && (
          <select
            aria-label="文件夹"
            className="field !h-7 !w-auto !py-0 text-xs"
            value={range === 'folder' ? folder : ''}
            onChange={(e) => {
              setFolder(e.target.value);
              setRange(e.target.value ? 'folder' : 'all');
            }}
          >
            <option value="">文件夹…</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div
        ref={scrollRef}
        className="mt-3 h-[52dvh] overflow-y-auto pr-1"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          void onFiles(e.dataTransfer.files);
        }}
      >
        {library.loaded && library.ids.length === 0 ? (
          <Empty icon={<Upload className="size-6" />} title={`没有找到${KIND_LABEL[kind]}`} hint="换个范围或关键词，或把本地文件拖到这里上传" />
        ) : (
          <AssetGrid
            ids={library.ids}
            scrollRef={scrollRef}
            minTile={104}
            selection={selection}
            onSelectionChange={(next) => {
              // 单选：点哪个就是哪个；多选：超过上限时不再增加
              if (max === 1) {
                const added = [...next.selected].find((id) => !selection.selected.has(id));
                setSelection({ selected: new Set(added ? [added] : []), selecting: true });
              } else if (next.selected.size <= max) {
                setSelection({ ...next, selecting: true });
              }
            }}
            onOpen={() => undefined}
            hasMore={library.hasMore}
            loading={library.loading}
            onLoadMore={library.loadMore}
          />
        )}
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        {max > 1 && <span className="mr-auto text-xs text-fg-3">最多选 {max} 个</span>}
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button
          variant="primary"
          disabled={!ordered.length}
          onClick={() => {
            onPick(ordered.map((id) => assets[id]).filter(Boolean));
            onClose();
          }}
        >
          使用所选{ordered.length ? `（${ordered.length}）` : ''}
        </Button>
      </div>
    </Modal>
  );
}
