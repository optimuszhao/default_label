// 虚拟网格：只渲染可见的几行，十万张素材也不卡。网格里只放缩略图和视频封面，不挂 <video>。
// 桌面：单击打开详情，⌘/Ctrl 单击多选，Shift 单击范围选择，拖到左侧文件夹移动。
// 手机：点按打开，长按进入多选。
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { Check, Heart, Music, Play, Star, ThumbsDown } from 'lucide-react';
import type { Asset } from '../../../../shared/types.ts';
import { useStore } from '../../lib/store.ts';
import { cx, formatDuration } from '../../lib/util.ts';
import { Media, Spinner } from '../ui.tsx';

export const DRAG_TYPE = 'application/x-weave-assets';

export interface GridSelection {
  selected: Set<string>;
  /** 多选模式（手机长按后进入，桌面有选中项时也算） */
  selecting: boolean;
}

const Tile = memo(function Tile({
  asset,
  size,
  selected,
  active,
  selecting,
  onClick,
  onToggle,
  onLongPress,
  onDragStart,
}: {
  asset: Asset;
  size: number;
  selected: boolean;
  active: boolean;
  selecting: boolean;
  onClick: (event: MouseEvent, id: string) => void;
  onToggle: (id: string) => void;
  onLongPress: (id: string) => void;
  onDragStart: (event: React.DragEvent, id: string) => void;
}) {
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const cancel = () => {
    if (press.current) clearTimeout(press.current);
    press.current = null;
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={asset.prompt ?? asset.filename ?? '素材'}
      aria-pressed={selected}
      draggable
      onDragStart={(event) => onDragStart(event, asset.id)}
      onClick={(event) => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        onClick(event, asset.id);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onClick(event as unknown as MouseEvent, asset.id);
        if (event.key === ' ') {
          event.preventDefault();
          onToggle(asset.id);
        }
      }}
      onTouchStart={() => {
        longPressed.current = false;
        press.current = setTimeout(() => {
          longPressed.current = true;
          onLongPress(asset.id);
        }, 450);
      }}
      onTouchEnd={cancel}
      onTouchMove={cancel}
      onContextMenu={(event) => {
        // 手机长按会触发系统菜单
        if (selecting || 'ontouchstart' in window) event.preventDefault();
      }}
      style={{ width: size, height: size }}
      className={cx(
        'group relative cursor-pointer overflow-hidden rounded-lg border bg-ink-2 outline-none select-none focus-visible:ring-2 focus-visible:ring-accent',
        selected ? 'border-accent ring-2 ring-accent' : active ? 'border-accent/60' : 'border-line',
      )}
    >
      <Media asset={asset} variant="thumb" className={cx('pointer-events-none', selected && 'scale-[0.94] rounded-md transition-transform')} />
      {asset.kind === 'video' && (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] text-white backdrop-blur">
          <Play className="size-2.5 fill-current" />
          {asset.duration ? formatDuration(asset.duration) : ''}
        </span>
      )}
      {asset.kind === 'audio' && asset.duration ? (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
          <Music className="size-2.5" />
          {formatDuration(asset.duration)}
        </span>
      ) : null}
      <div className="pointer-events-none absolute top-1.5 right-1.5 flex items-center gap-1">
        {asset.flag === 'reject' && <ThumbsDown className="size-3.5 text-danger drop-shadow" />}
        {asset.rating > 0 && (
          <span className="flex items-center gap-0.5 rounded-full bg-black/60 px-1 py-0.5 text-[10px] text-warn">
            <Star className="size-2.5 fill-current" />
            {asset.rating}
          </span>
        )}
        {asset.favorite && <Heart className="size-3.5 fill-pink text-pink drop-shadow" />}
      </div>
      <button
        aria-label={selected ? '取消选择' : '选择'}
        onClick={(event) => {
          event.stopPropagation();
          onToggle(asset.id);
        }}
        className={cx(
          'absolute top-1.5 left-1.5 flex size-5 items-center justify-center rounded-full border transition',
          selected ? 'border-accent bg-accent text-white' : 'border-white/70 bg-black/30 text-transparent',
          selected || selecting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        <Check className="size-3" />
      </button>
      {asset.flag === 'pick' && <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-ok" />}
    </div>
  );
});

export function AssetGrid({
  ids,
  scrollRef,
  selection,
  onSelectionChange,
  onOpen,
  activeId,
  hasMore,
  loading,
  onLoadMore,
  minTile = 132,
  gap = 6,
}: {
  ids: string[];
  /** 滚动容器（网格在它里面虚拟滚动） */
  scrollRef: RefObject<HTMLDivElement | null>;
  selection: GridSelection;
  onSelectionChange: (selection: GridSelection) => void;
  onOpen: (id: string) => void;
  activeId?: string | null;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  minTile?: number;
  gap?: number;
}) {
  const assets = useStore((s) => s.assets);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [margin, setMargin] = useState(0);
  const anchor = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      // 网格在滚动容器里的起始位置（上面可能有标题、筛选条）
      const scroller = scrollRef.current;
      if (scroller) setMargin(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [scrollRef]);

  const columns = Math.max(3, Math.floor((width + gap) / (minTile + gap)) || 3);
  const tile = width ? Math.floor((width - gap * (columns - 1)) / columns) : minTile;
  const rows = Math.ceil(ids.length / columns);

  const virtualizer = useVirtualizer({
    count: rows + (hasMore ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => tile + gap,
    overscan: 4,
    scrollMargin: margin,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [tile, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const lastRow = items.at(-1)?.index ?? 0;
  useEffect(() => {
    if (hasMore && !loading && lastRow >= rows - 2) onLoadMore();
  }, [lastRow, rows, hasMore, loading, onLoadMore]);

  function toggle(id: string) {
    const next = new Set(selection.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    anchor.current = id;
    onSelectionChange({ selected: next, selecting: next.size > 0 || selection.selecting });
  }

  function onClick(event: MouseEvent, id: string) {
    if (event.shiftKey && anchor.current) {
      const a = ids.indexOf(anchor.current);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const next = new Set(selection.selected);
        for (const item of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(item);
        onSelectionChange({ selected: next, selecting: true });
        return;
      }
    }
    if (event.metaKey || event.ctrlKey || selection.selecting) {
      toggle(id);
      return;
    }
    anchor.current = id;
    onOpen(id);
  }

  function onDragStart(event: React.DragEvent, id: string) {
    const dragged = selection.selected.has(id) ? [...selection.selected] : [id];
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragged));
    event.dataTransfer.effectAllowed = 'move';
  }

  return (
    <div ref={containerRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {items.map((row) => {
        const start = row.index * columns;
        const rowIds = ids.slice(start, start + columns);
        return (
          <div
            key={row.key}
            className="absolute left-0 flex w-full"
            style={{ top: row.start - virtualizer.options.scrollMargin, height: tile, gap }}
          >
            {row.index >= rows ? (
              <div className="flex w-full items-center justify-center">{loading && <Spinner />}</div>
            ) : (
              rowIds.map((id) => {
                const asset = assets[id];
                if (!asset) return <div key={id} style={{ width: tile, height: tile }} className="skeleton rounded-lg" />;
                return (
                  <Tile
                    key={id}
                    asset={asset}
                    size={tile}
                    selected={selection.selected.has(id)}
                    active={activeId === id}
                    selecting={selection.selecting}
                    onClick={onClick}
                    onToggle={toggle}
                    onLongPress={(target) => {
                      const next = new Set(selection.selected);
                      next.add(target);
                      anchor.current = target;
                      onSelectionChange({ selected: next, selecting: true });
                    }}
                    onDragStart={onDragStart}
                  />
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
}
