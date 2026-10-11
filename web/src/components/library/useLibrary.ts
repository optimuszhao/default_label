// 资产库列表：按查询条件分页加载（无限滚动），新生成的素材实时插到最前，删除的实时移除。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, AssetQuery } from '../../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';

/** 新素材是否属于当前视图：只在没有复杂条件时自动插入，避免插错 */
function acceptsFresh(query: AssetQuery, asset: Asset): boolean {
  if (query.trash || query.q || query.folder || query.tag || query.flag || query.minRating || query.favorite || query.unfiled) return false;
  if (query.sort && query.sort !== 'new') return false;
  if (query.kind && asset.kind !== query.kind) return false;
  if (query.source && asset.source !== query.source) return false;
  if (query.storyId && asset.storyId !== query.storyId) return false;
  return !asset.deletedAt;
}

export function useLibrary(query: AssetQuery, options: { pageSize?: number; enabled?: boolean } = {}) {
  const pageSize = options.pageSize ?? 120;
  const enabled = options.enabled ?? true;
  const [ids, setIds] = useState<string[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0);
  const assets = useStore((s) => s.assets);
  const removed = useStore((s) => s.removedAssets);
  const upsertAssets = useStore((s) => s.upsertAssets);
  const key = JSON.stringify(query);
  const request = useRef(0);
  const known = useRef(new Set<string>());

  const loadPage = useCallback(
    async (cursor: string | null) => {
      const seq = ++request.current;
      setLoading(true);
      try {
        const page = await api.library(JSON.parse(key) as AssetQuery, cursor, pageSize);
        if (seq !== request.current) return;
        upsertAssets(page.items);
        setIds((prev) => {
          const merged = cursor ? [...prev, ...page.items.map((a) => a.id).filter((id) => !prev.includes(id))] : page.items.map((a) => a.id);
          known.current = new Set(merged);
          return merged;
        });
        setNext(page.next);
        setLoaded(true);
      } catch (error) {
        if (seq === request.current) reportError(error);
      } finally {
        if (seq === request.current) setLoading(false);
      }
    },
    [key, pageSize, upsertAssets],
  );

  useEffect(() => {
    if (!enabled) return;
    setIds([]);
    setNext(null);
    setLoaded(false);
    known.current = new Set();
    void loadPage(null);
  }, [loadPage, version, enabled]);

  // 实时插入刚生成或刚上传的素材
  useEffect(() => {
    if (!loaded) return;
    const parsed = JSON.parse(key) as AssetQuery;
    const fresh = Object.values(assets).filter((asset) => !known.current.has(asset.id) && Date.now() - asset.createdAt < 120_000 && acceptsFresh(parsed, asset));
    if (!fresh.length) return;
    fresh.sort((a, b) => b.createdAt - a.createdAt);
    for (const asset of fresh) known.current.add(asset.id);
    setIds((prev) => [...fresh.map((a) => a.id), ...prev]);
  }, [assets, key, loaded]);

  const parsed = useMemo(() => JSON.parse(key) as AssetQuery, [key]);
  const visible = useMemo(
    () =>
      ids.filter((id) => {
        const asset = assets[id];
        if (!asset) return false;
        // 回收站视图里：恢复了的移走；其他视图里：删除了的移走
        if (parsed.trash) return Boolean(asset.deletedAt) && !removed.has(id);
        return !removed.has(id) && !asset.deletedAt;
      }),
    [ids, assets, removed, parsed.trash],
  );

  return {
    ids: visible,
    loading,
    loaded,
    hasMore: Boolean(next),
    loadMore: () => {
      if (next && !loading) void loadPage(next);
    },
    refresh: () => setVersion((v) => v + 1),
    /** 本地插入（上传完成后马上显示） */
    prepend: (newIds: string[]) => {
      for (const id of newIds) known.current.add(id);
      setIds((prev) => [...newIds.filter((id) => !prev.includes(id)), ...prev]);
    },
  };
}
