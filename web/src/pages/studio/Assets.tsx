import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Heart, ImageOff, Play, Upload } from 'lucide-react';
import type { Asset } from '../../../../shared/types.ts';
import { useUpload } from '../../components/AssetPicker.tsx';
import { Lightbox } from '../../components/Lightbox.tsx';
import { Button, Empty, Media, Segmented, Spinner, isVideoAsset } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { cx } from '../../lib/util.ts';

type Filter = 'all' | 'image' | 'video' | 'favorite' | 'upload';
const PAGE = 60;

export default function Assets() {
  const [filter, setFilter] = useState<Filter>('all');
  const [ids, setIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [viewing, setViewing] = useState<string | null>(null);
  const assets = useStore((s) => s.assets);
  const upsertAssets = useStore((s) => s.upsertAssets);
  const { upload, uploading } = useUpload();
  const inputRef = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const query = useMemo(
    () => ({
      kind: filter === 'image' || filter === 'video' ? filter : undefined,
      favorite: filter === 'favorite',
      source: filter === 'upload' ? 'upload' : undefined,
    }),
    [filter],
  );

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      try {
        const page = await api.assets({ ...query, before, limit: PAGE });
        upsertAssets(page);
        setIds((prev) => (before ? [...prev, ...page.map((a) => a.id)] : page.map((a) => a.id)));
        setHasMore(page.length === PAGE);
      } catch (error) {
        reportError(error);
      } finally {
        setLoading(false);
      }
    },
    [query, upsertAssets],
  );

  useEffect(() => {
    setIds([]);
    void load();
  }, [load]);

  // 生成完成的新资产实时出现在列表顶部
  const knownIds = useRef(new Set<string>());
  useEffect(() => {
    knownIds.current = new Set(ids);
  }, [ids]);
  useEffect(() => {
    const fresh = Object.values(assets).filter(
      (asset) =>
        !knownIds.current.has(asset.id) &&
        Date.now() - asset.createdAt < 60_000 &&
        (filter === 'all' || filter === asset.kind || (filter === 'upload' && asset.source === 'upload')),
    );
    if (fresh.length) setIds((prev) => [...fresh.map((a) => a.id), ...prev.filter((id) => !fresh.some((a) => a.id === id))]);
  }, [assets, filter]);

  // 无限滚动
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loading) {
        const last = assets[ids[ids.length - 1]];
        if (last) void load(`${last.createdAt}:${last.id}`);
      }
    }, { rootMargin: '600px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, ids, assets, load]);

  const items = ids
    .map((id) => assets[id])
    .filter((asset): asset is Asset => Boolean(asset))
    .filter((asset) => filter !== 'favorite' || asset.favorite);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 md:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">资产库</h1>
          <p className="mt-1 text-sm text-fg-3">所有生成和上传的图片、视频。点击查看，可直接用于图生图或图生视频。</p>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
          hidden
          onChange={async (e) => {
            if (!e.target.files?.length) return;
            const uploaded = await upload(e.target.files);
            setIds((prev) => [...uploaded.map((a) => a.id), ...prev]);
            e.target.value = '';
          }}
        />
        <Button icon={<Upload className="size-4" />} loading={uploading} onClick={() => inputRef.current?.click()}>上传素材</Button>
      </div>

      <div className="no-scrollbar -mx-4 mt-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'image', label: '图片' },
            { value: 'video', label: '视频' },
            { value: 'favorite', label: '收藏' },
            { value: 'upload', label: '我的上传' },
          ]}
        />
      </div>

      <div className="mt-5">
        {!loading && items.length === 0 ? (
          <Empty icon={<ImageOff className="size-6" />} title="这里还空空如也" hint="去创作页生成第一张作品，或上传本地素材。" />
        ) : (
          <div className="columns-2 gap-2 sm:columns-3 sm:gap-3 lg:columns-4 xl:columns-5">
            {items.map((asset) => (
              <button
                key={asset.id}
                onClick={() => setViewing(asset.id)}
                className="group relative mb-2 block w-full break-inside-avoid overflow-hidden rounded-xl border border-line bg-ink-2 sm:mb-3"
                style={{ aspectRatio: asset.width && asset.height ? `${asset.width} / ${asset.height}` : '1 / 1' }}
              >
                <Media asset={asset} className="transition-transform duration-700 ease-[var(--ease-out-expo)] group-hover:scale-[1.03]" />
                {(isVideoAsset(asset) || asset.kind === 'video') && (
                  <span className="pointer-events-none absolute top-2 left-2 flex size-6 items-center justify-center rounded-full bg-black/55 backdrop-blur">
                    <Play className="size-3 fill-current" />
                  </span>
                )}
                {asset.favorite && <Heart className="absolute top-2 right-2 size-4 fill-pink text-pink drop-shadow" />}
                {asset.prompt && (
                  <span className={cx('pointer-events-none absolute inset-x-0 bottom-0 line-clamp-2 bg-black/70 p-2.5 text-left text-[11px] text-white/85 opacity-0 transition-opacity group-hover:opacity-100')}>
                    {asset.prompt}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <div ref={sentinel} className="flex justify-center py-8">{loading && <Spinner />}</div>
      </div>

      <Lightbox
        asset={viewing ? assets[viewing] ?? null : null}
        onClose={() => setViewing(null)}
        onDeleted={(id) => setIds((prev) => prev.filter((item) => item !== id))}
      />
    </div>
  );
}
