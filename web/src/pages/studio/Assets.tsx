// 资产库 2.0：左侧视图 / 文件夹 / 标签 / 智能文件夹，中间搜索筛选和虚拟网格，右侧详情抽屉。
// 手机端：侧栏和详情都是底部弹出的面板，长按进入多选。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bookmark, ImageOff, PanelLeft, Search, Upload, X } from 'lucide-react';
import type { AssetFolder, AssetQuery, AssetTag, SavedSearch, StorageUsage } from '../../../../shared/types.ts';
import { AssetDetail } from '../../components/library/AssetDetail.tsx';
import { AssetGrid, type GridSelection } from '../../components/library/AssetGrid.tsx';
import { BatchBar } from '../../components/library/BatchBar.tsx';
import { LibrarySidebar, scopeQuery, type Scope } from '../../components/library/LibrarySidebar.tsx';
import { StorageDialog } from '../../components/library/StorageDialog.tsx';
import { useLibrary } from '../../components/library/useLibrary.ts';
import { promptDialog } from '../../components/ConfirmDialog.tsx';
import { Lightbox } from '../../components/Lightbox.tsx';
import { Button, Empty, Modal, Segmented } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { ACCEPT_MEDIA, uploadFile } from '../../lib/upload.ts';
import { cx, useDebouncedCallback, useMediaQuery } from '../../lib/util.ts';

type KindFilter = '' | 'image' | 'video' | 'audio';

function parseScope(raw: string | null): Scope {
  if (!raw) return { type: 'all' };
  const [type, id] = raw.split(':');
  if ((type === 'folder' || type === 'tag' || type === 'saved' || type === 'story') && id) return { type, id };
  if (['all', 'recent', 'favorite', 'pick', 'unfiled', 'trash'].includes(type)) return { type: type as 'all' };
  return { type: 'all' };
}

function scopeKey(scope: Scope): string {
  return 'id' in scope ? `${scope.type}:${scope.id}` : scope.type;
}

interface UploadItem {
  key: string;
  name: string;
  progress: number;
  error?: string;
}

const EMPTY_SELECTION: GridSelection = { selected: new Set(), selecting: false };

export default function Assets() {
  const [params, setParams] = useSearchParams();
  const scope = parseScope(params.get('scope'));
  const detailId = params.get('asset');
  const [kind, setKind] = useState<KindFilter>('');
  const [sort, setSort] = useState<AssetQuery['sort']>('new');
  const [minRating, setMinRating] = useState(0);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [folders, setFolders] = useState<AssetFolder[]>([]);
  const [tags, setTags] = useState<AssetTag[]>([]);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [selection, setSelection] = useState<GridSelection>(EMPTY_SELECTION);
  const [allMatching, setAllMatching] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const assets = useStore((s) => s.assets);
  const upsertAssets = useStore((s) => s.upsertAssets);
  const toast = useStore((s) => s.toast);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const applySearch = useDebouncedCallback((value: string) => setQ(value.trim()), 300);
  const desktop = useMediaQuery('(min-width: 1024px)');

  const query = useMemo<AssetQuery>(() => {
    const base = scopeQuery(scope, saved);
    return {
      ...base,
      ...(kind ? { kind } : {}),
      ...(q ? { q: [base.q, q].filter(Boolean).join(' ') } : {}),
      ...(minRating ? { minRating: Math.max(minRating, base.minRating ?? 0) } : {}),
      ...(sort && sort !== 'new' ? { sort } : {}),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey(scope), saved, kind, q, minRating, sort]);

  const library = useLibrary(query);

  const loadMeta = useCallback(async () => {
    try {
      const [f, t, s, u] = await Promise.all([api.folders(), api.tags(), api.savedSearches(), api.storageUsage()]);
      setFolders(f);
      setTags(t);
      setSaved(s);
      setUsage(u);
    } catch (error) {
      reportError(error);
    }
  }, []);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  // 条件变化：清空选择，更新总数（"选中全部"用）
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    setSelection(EMPTY_SELECTION);
    setAllMatching(false);
    setTotal(null);
    void api.facets(query).then((f) => setTotal(f.total)).catch(() => undefined);
    scrollRef.current?.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  function setScope(next: Scope) {
    setSidebarOpen(false);
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next.type === 'all') p.delete('scope');
      else p.set('scope', scopeKey(next));
      p.delete('asset');
      return p;
    });
  }

  function openDetail(id: string | null) {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (id) p.set('asset', id);
      else p.delete('asset');
      return p;
    }, { replace: true });
  }

  // 详情里的素材不在缓存中（从深链接打开）：单独拉一次
  useEffect(() => {
    if (detailId && !assets[detailId]) void api.asset(detailId).then((a) => upsertAssets([a])).catch(() => openDetail(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailId]);

  // Esc 取消选择；⌘A 全选已加载的
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (event.key === 'Escape' && selection.selected.size) setSelection(EMPTY_SELECTION);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelection({ selected: new Set(library.ids), selecting: true });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection.selected.size, library.ids]);

  async function onFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    const folderId = scope.type === 'folder' ? scope.id : null;
    const items = list.map((file, i) => ({ key: `${Date.now()}-${i}-${file.name}`, name: file.name, progress: 0 }));
    setUploads((prev) => [...prev, ...items]);
    let duplicates = 0;
    for (const [i, file] of list.entries()) {
      const key = items[i].key;
      try {
        const result = await uploadFile(file, {
          folderId,
          onProgress: (progress) => setUploads((prev) => prev.map((item) => (item.key === key ? { ...item, progress } : item))),
        });
        upsertAssets([result.asset]);
        library.prepend([result.asset.id]);
        if (result.duplicate) duplicates++;
        setUploads((prev) => prev.filter((item) => item.key !== key));
      } catch (error) {
        setUploads((prev) => prev.map((item) => (item.key === key ? { ...item, error: (error as Error).message } : item)));
      }
    }
    if (duplicates) toast(`${duplicates} 个文件之前上传过，已直接使用原来的素材`, 'info');
    void loadMeta();
  }

  async function saveSearch() {
    const name = await promptDialog({ title: '保存为智能文件夹', placeholder: '例如：女主高分图', maxLength: 40, confirmText: '保存' });
    if (!name) return;
    try {
      const { trash: _trash, ...rest } = query;
      await api.saveSearch(name, rest);
      void loadMeta();
      toast('已保存到左侧"智能文件夹"', 'success');
    } catch (error) {
      reportError(error);
    }
  }

  const selectedIds = [...selection.selected];
  const titles: Record<string, string> = { all: '全部素材', recent: '最近 7 天', favorite: '收藏', pick: '已挑选', unfiled: '未归档', trash: '回收站' };
  const title =
    scope.type === 'folder'
      ? folders.find((f) => f.id === scope.id)?.name ?? '文件夹'
      : scope.type === 'tag'
        ? `#${tags.find((t) => t.id === scope.id)?.name ?? '标签'}`
        : scope.type === 'saved'
          ? saved.find((s) => s.id === scope.id)?.name ?? '智能文件夹'
          : scope.type === 'story'
            ? '故事素材'
            : titles[scope.type];
  const filtered = Boolean(q || kind || minRating || (sort && sort !== 'new'));

  const sidebar = (
    <LibrarySidebar
      scope={scope}
      onScope={setScope}
      folders={folders}
      tags={tags}
      saved={saved}
      usage={usage}
      onChanged={() => void loadMeta()}
      onMoved={() => library.refresh()}
      onOpenStorage={() => setStorageOpen(true)}
    />
  );

  const detail = detailId && assets[detailId] && (
    <AssetDetail
      assetId={detailId}
      folders={folders}
      onClose={() => openDetail(null)}
      onOpenViewer={setViewer}
      onNavigate={(id) => openDetail(id)}
      onChanged={() => void loadMeta()}
    />
  );

  return (
    <div
      className="flex h-[calc(100dvh-3.5rem-76px-env(safe-area-inset-bottom))] md:h-dvh"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragOver(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDragOver(false);
        void onFiles(event.dataTransfer.files);
      }}
    >
      <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-line p-3 xl:block">{sidebar}</aside>

      <section className="relative flex min-w-0 flex-1 flex-col">
        <header className="space-y-3 border-b border-line px-3 py-3 sm:px-4">
          <div className="flex items-center gap-2">
            <button aria-label="打开资产库导航" onClick={() => setSidebarOpen(true)} className="rounded-lg p-2 text-fg-2 hover:bg-white/[0.06] xl:hidden">
              <PanelLeft className="size-4" />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
              <p className="text-xs text-fg-3">
                {total === null ? '…' : `${total} 个素材`}
                {scope.type === 'trash' && ' · 30 天后自动彻底删除'}
              </p>
            </div>
            <input ref={fileInput} type="file" multiple accept={ACCEPT_MEDIA} hidden onChange={(e) => { if (e.target.files) void onFiles(e.target.files); e.target.value = ''; }} />
            {scope.type !== 'trash' && (
              <Button size="sm" icon={<Upload className="size-4" />} onClick={() => fileInput.current?.click()}>
                上传
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-40 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-3" />
              <input
                className="field !h-8 !pl-8 text-[13px]"
                placeholder="搜索提示词、备注、标签、文件名"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  applySearch(e.target.value);
                }}
              />
              {search && (
                <button aria-label="清除搜索" onClick={() => { setSearch(''); setQ(''); }} className="absolute top-1/2 right-2 -translate-y-1/2 text-fg-3 hover:text-fg">
                  <X className="size-3.5" />
                </button>
              )}
            </label>
            <Segmented
              size="sm"
              value={kind}
              onChange={setKind}
              label="类型"
              options={[
                { value: '', label: '全部' },
                { value: 'image', label: '图片' },
                { value: 'video', label: '视频' },
                { value: 'audio', label: '音频' },
              ]}
            />
            <select aria-label="评分" className="field !h-8 !w-auto !py-0 text-xs" value={minRating} onChange={(e) => setMinRating(Number(e.target.value))}>
              <option value={0}>不限评分</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} 星以上
                </option>
              ))}
            </select>
            <select aria-label="排序" className="field !h-8 !w-auto !py-0 text-xs" value={sort} onChange={(e) => setSort(e.target.value as AssetQuery['sort'])}>
              <option value="new">最新</option>
              <option value="old">最早</option>
              <option value="rating">评分</option>
              <option value="size">文件大小</option>
            </select>
            {filtered && scope.type !== 'trash' && (
              <button onClick={() => void saveSearch()} className="chip !h-8" title="把当前条件保存为智能文件夹">
                <Bookmark className="size-3.5" /> 保存条件
              </button>
            )}
          </div>
        </header>

        {uploads.length > 0 && (
          <div className="space-y-1 border-b border-line px-4 py-2">
            {uploads.map((item) => (
              <div key={item.key} className="flex items-center gap-2 text-xs">
                <span className="w-40 truncate text-fg-2">{item.name}</span>
                {item.error ? (
                  <>
                    <span className="flex-1 text-danger">{item.error}</span>
                    <button className="text-fg-3 hover:text-fg" onClick={() => setUploads((prev) => prev.filter((u) => u.key !== item.key))}>
                      <X className="size-3.5" />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
                      <span className="block h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(item.progress * 100)}%` }} />
                    </span>
                    <span className="w-10 text-right text-fg-3 tabular-nums">{Math.round(item.progress * 100)}%</span>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-28 sm:px-4">
          {library.loaded && library.ids.length === 0 ? (
            <Empty
              icon={<ImageOff className="size-6" />}
              title={scope.type === 'trash' ? '回收站是空的' : filtered ? '没有符合条件的素材' : '这里还空空如也'}
              hint={scope.type === 'trash' ? '删除的素材会在这里保留 30 天。' : filtered ? '换个关键词或放宽筛选条件试试。' : '去创作页生成作品，或把本地图片、视频、音频拖到这里上传。'}
            />
          ) : (
            <AssetGrid
              ids={library.ids}
              scrollRef={scrollRef}
              selection={selection}
              onSelectionChange={(next) => {
                setSelection(next);
                if (!next.selected.size) setAllMatching(false);
              }}
              onOpen={openDetail}
              activeId={detailId}
              hasMore={library.hasMore}
              loading={library.loading}
              onLoadMore={library.loadMore}
            />
          )}
        </div>

        {dragOver && (
          <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent/10 text-sm text-fg">
            松开即可上传{scope.type === 'folder' ? `到「${title}」` : ''}
          </div>
        )}
      </section>

      {detail && desktop && <div className="w-80 shrink-0 border-l border-line xl:w-96">{detail}</div>}

      {/* 窄屏：详情和导航用底部面板 */}
      <Modal open={Boolean(detail) && !desktop} onClose={() => openDetail(null)} bare>
        <div className={cx('panel h-[86dvh] overflow-hidden bg-ink-1')}>{detail}</div>
      </Modal>
      <Modal open={sidebarOpen} onClose={() => setSidebarOpen(false)} title="资产库">
        {sidebar}
      </Modal>
      <StorageDialog open={storageOpen} onClose={() => setStorageOpen(false)} onChanged={() => { void loadMeta(); library.refresh(); }} />

      {selection.selected.size > 0 && (
        <BatchBar
          ids={selectedIds}
          allMatching={allMatching}
          query={query}
          total={total}
          trash={scope.type === 'trash'}
          folders={folders}
          onSelectAll={() => setAllMatching(true)}
          onClear={() => {
            setSelection(EMPTY_SELECTION);
            setAllMatching(false);
          }}
          onDone={(changed) => {
            setSelection(EMPTY_SELECTION);
            setAllMatching(false);
            void loadMeta();
            if (changed) library.refresh();
            void api.facets(query).then((f) => setTotal(f.total)).catch(() => undefined);
          }}
        />
      )}

      <Lightbox asset={viewer ? (assets[viewer] ?? null) : null} onClose={() => setViewer(null)} list={library.ids.map((id) => assets[id]).filter(Boolean)} />
    </div>
  );
}
