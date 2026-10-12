// 创作台 2.0：像聊天一样，最新的作品在最下面紧挨输入区，往上翻是更早的历史（按天分组，一直能翻到最早）
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Check,
  Clapperboard,
  Columns2,
  Download,
  Film,
  Heart,
  Image as ImageIcon,
  Lightbulb,
  Maximize2,
  Play,
  RotateCcw,
  Search,
  Shuffle,
  SlidersHorizontal,
  Square,
} from 'lucide-react';
import { emptyRecipe } from '../../../../shared/compose.ts';
import { TASK_TYPE_LABEL, type Asset, type Task } from '../../../../shared/types.ts';
import { AssetViewer, fileName, MotionSheet } from '../../components/AssetViewer.tsx';
import { CompareView } from '../../components/CompareView.tsx';
import { Button, Empty, IconButton, Media, ProgressBar, Segmented, Spinner, StatusBadge } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { cssRatio } from '../../lib/presets.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { cx, downloadUrl, timeAgo, useDebouncedCallback } from '../../lib/util.ts';
import { useCatalog } from './create/catalog.ts';
import { ComposerDock } from './create/Composer.tsx';
import { useCompare, useDerive } from './create/derive.ts';
import { useComposer } from './create/useComposer.ts';

type Kind = 'all' | 'image' | 'video';

const isVideoTask = (task: Task) => task.type === 't2v' || task.type === 'i2v';

function dayLabel(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(today) - start(date)) / 86400_000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  return date.getFullYear() === today.getFullYear() ? `${date.getMonth() + 1}月${date.getDate()}日` : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

const FeedCard = memo(function FeedCard({ task, onOpen }: { task: Task; onOpen: (asset: Asset, list: Asset[]) => void }) {
  const assets = useStore((s) => s.assets);
  const upsertTasks = useStore((s) => s.upsertTasks);
  const templates = useCatalog((s) => s.templates);
  const compare = useCompare();
  const derive = useDerive();
  const [motionFor, setMotionFor] = useState<Asset | null>(null);
  const outputs = task.outputAssetIds.map((id) => assets[id]).filter((asset): asset is Asset => Boolean(asset));
  const video = isVideoTask(task);
  const pending = task.status !== 'succeeded';
  const slots = pending ? Math.max(1, task.params.count || 1) : outputs.length;
  const refs = [...(task.inputs.referenceAssetIds ?? []), task.inputs.firstFrameAssetId].filter(Boolean) as string[];
  const template = templates.find((t) => t.id === task.recipe?.templateId);
  const selecting = compare.ids.length > 0;

  async function act(action: 'run' | 'cancel' | 'retry') {
    try {
      upsertTasks([await api.taskAction(task.id, action)]);
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <article className="cv-auto" data-feed-card>
      <div className="mb-2.5 flex items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.06]">
          {video ? <Film className="size-3.5" /> : <ImageIcon className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm leading-relaxed text-fg" title={task.prompt}>
            {task.recipe?.text || task.prompt}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
            <StatusBadge status={task.status} waiting={Boolean(task.waitReason)} />
            <span>{TASK_TYPE_LABEL[task.type]}</span>
            {template && <span className="rounded bg-accent/10 px-1.5 text-accent">{template.name}</span>}
            {task.recipe && task.recipe.presets.length > 0 && <span>{task.recipe.presets.length} 个预设</span>}
            <span>
              {task.params.width}×{task.params.height}
            </span>
            {video && <span>{task.params.duration}s</span>}
            {refs.length > 0 && <span>{refs.length} 张参考</span>}
            <span>{timeAgo(task.createdAt)}</span>
          </div>
        </div>
      </div>

      <div className={cx('grid gap-2', slots > 1 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1 sm:max-w-xl')}>
        {pending
          ? Array.from({ length: slots }, (_, i) => (
              <div
                key={i}
                className="relative flex flex-col items-center justify-center overflow-hidden rounded-xl border border-line bg-ink-2"
                style={{ aspectRatio: cssRatio(task.params.aspectRatio) }}
              >
                {(task.status === 'running' || task.status === 'queued') && <div className="skeleton absolute inset-0" />}
                <div className="relative px-4 text-center">
                  {task.status === 'running' && (
                    <>
                      <p className="font-mono text-2xl font-semibold">{Math.round(task.progress * 100)}%</p>
                      <ProgressBar value={task.progress} className="mt-2 w-24" />
                      {task.stage && <p className="mt-2 text-xs text-fg-2">{task.stage}</p>}
                    </>
                  )}
                  {task.status === 'queued' && <p className="text-xs text-fg-2">{task.waitReason ? '等待生成服务恢复…' : '排队中…'}</p>}
                  {task.status === 'failed' && <p className="line-clamp-3 text-xs text-danger">{task.lastError ?? '生成失败'}</p>}
                  {task.status === 'paused' && <p className="text-xs text-fg-3">已暂停</p>}
                  {task.status === 'canceled' && <p className="text-xs text-fg-3">已取消</p>}
                </div>
              </div>
            ))
          : outputs.map((asset) => {
              const chosen = compare.ids.includes(asset.id);
              return (
                <div
                  key={asset.id}
                  className={cx('group relative overflow-hidden rounded-xl border bg-ink-2', chosen ? 'border-accent' : 'border-line')}
                  style={{ aspectRatio: cssRatio(task.params.aspectRatio) }}
                >
                  <button className="absolute inset-0" onClick={() => (selecting ? compare.toggle(asset.id) : onOpen(asset, outputs))} aria-label="查看大图">
                    <Media asset={asset} />
                  </button>
                  <button
                    aria-label={chosen ? '移出对比' : '加入对比'}
                    onClick={() => compare.toggle(asset.id)}
                    className={cx(
                      'absolute top-2 right-2 flex size-6 items-center justify-center rounded-md border transition',
                      chosen ? 'border-accent bg-accent text-white' : 'border-white/50 bg-black/40 opacity-100 sm:opacity-0 sm:group-hover:opacity-100',
                      selecting && 'sm:opacity-100',
                    )}
                  >
                    {chosen ? <Check className="size-3.5" /> : <Columns2 className="size-3" />}
                  </button>
                  {asset.favorite && <Heart className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 fill-danger text-danger" />}
                  {video && (
                    <span className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] backdrop-blur">
                      <Play className="size-2.5 fill-current" /> {asset.duration ?? task.params.duration}s
                    </span>
                  )}
                  <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-black/55 p-1.5 opacity-100 transition-opacity duration-200 sm:opacity-0 sm:group-hover:opacity-100">
                    {!video && (
                      <>
                        <IconButton label="变体" className="size-8 bg-black/40" onClick={() => void derive.variant(asset, task)}>
                          <Shuffle className="size-3.5" />
                        </IconButton>
                        <IconButton label="图转视频" className="size-8 bg-black/40" onClick={() => setMotionFor(asset)}>
                          <Clapperboard className="size-3.5" />
                        </IconButton>
                      </>
                    )}
                    <IconButton label="下载" className="size-8 bg-black/40" onClick={() => downloadUrl(asset.url, fileName(asset))}>
                      <Download className="size-3.5" />
                    </IconButton>
                    <IconButton label="查看详情" className="size-8 bg-black/40" onClick={() => onOpen(asset, outputs)}>
                      <Maximize2 className="size-3.5" />
                    </IconButton>
                  </div>
                </div>
              );
            })}
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {task.status === 'queued' && (
          <Button size="sm" variant="ghost" icon={<Play className="size-3.5" />} onClick={() => void act('run')}>
            立即运行
          </Button>
        )}
        {(task.status === 'queued' || task.status === 'running' || task.status === 'paused') && (
          <Button size="sm" variant="ghost" icon={<Square className="size-3.5" />} onClick={() => void act('cancel')}>
            取消
          </Button>
        )}
        {(task.status === 'failed' || task.status === 'canceled' || task.status === 'succeeded') && (
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => void (task.status === 'succeeded' ? derive.rerun(task) : act('retry'))}>
            {task.status === 'succeeded' ? '再次生成' : '重试'}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<SlidersHorizontal className="size-3.5" />} onClick={() => derive.editRerun(task, outputs[0])}>
          改参数重跑
        </Button>
      </div>
      <MotionSheet asset={motionFor} onClose={() => setMotionFor(null)} />
    </article>
  );
});

const PAGE = 20;

export default function Create() {
  const composer = useComposer();
  const tasks = useStore((s) => s.tasks);
  const upsertTasks = useStore((s) => s.upsertTasks);
  const upsertAssets = useStore((s) => s.upsertAssets);
  const draft = useStore((s) => s.composerDraft);
  const setDraft = useStore((s) => s.setComposerDraft);
  const loadCatalog = useCatalog((s) => s.load);
  const [kind, setKind] = useState<Kind>('all');
  const [favorite, setFavorite] = useState(false);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [feedIds, setFeedIds] = useState<string[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [viewing, setViewing] = useState<{ asset: Asset; list: Asset[] } | null>(null);
  const mountedAt = useRef(Date.now());
  const sentinel = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);
  /** 视线锚点：当前看着的那张卡片和它离视口顶部的距离。上方插入更早的作品、图片加载、卡片渲染变高时，
   *  把它挪回原来的位置，视线就不会跳 */
  const anchor = useRef<{ el: Element; top: number } | null>(null);
  /** 首屏和提交新作品后贴到底部 */
  const stickBottom = useRef(true);
  const atBottom = useRef(true);
  /** 自己触发的滚动（贴底、挪回锚点）不重新记锚点，只有用户滚动才记 */
  const selfScroll = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // 其他页面跳过来时带的草稿：改参数重跑、以此为参考、图转视频、套用模板
  useEffect(() => {
    if (!draft) return;
    setDraft(null);
    void (async () => {
      const ids = [...(draft.referenceAssetIds ?? []), ...(draft.firstFrameAssetId ? [draft.firstFrameAssetId] : [])];
      const known = useStore.getState().assets;
      const fetched = await Promise.all(ids.filter((id) => !known[id]).map((id) => api.asset(id).catch(() => null)));
      upsertAssets(fetched.filter((a): a is Asset => Boolean(a)));
      const all = useStore.getState().assets;
      composer.load({
        mode: draft.mode,
        recipe: draft.recipe ?? { ...emptyRecipe(draft.mode), text: draft.prompt ?? '' },
        refs: (draft.referenceAssetIds ?? []).map((id) => all[id]).filter((a): a is Asset => Boolean(a)),
        firstFrame: draft.firstFrameAssetId ? (all[draft.firstFrameAssetId] ?? null) : null,
      });
    })();
  }, [draft, setDraft, upsertAssets, composer]);

  const loadPage = useCallback(
    async (reset: boolean) => {
      const gen = reset ? ++generation.current : generation.current;
      setLoading(true);
      try {
        const page = await api.feed({ before: reset ? null : next, limit: PAGE, kind: kind === 'all' ? undefined : kind, favorite, q: query });
        if (gen !== generation.current) return;
        upsertTasks(page.tasks);
        upsertAssets(page.assets);
        setFeedIds((prev) => (reset ? page.tasks.map((t) => t.id) : [...prev, ...page.tasks.map((t) => t.id).filter((id) => !prev.includes(id))]));
        setNext(page.next);
        setDone(!page.next);
      } catch (error) {
        reportError(error);
      } finally {
        if (gen === generation.current) setLoading(false);
      }
    },
    [next, kind, favorite, query, upsertTasks, upsertAssets],
  );

  // 筛选变化：从头加载
  useEffect(() => {
    stickBottom.current = true;
    setReady(false);
    setFeedIds([]);
    setNext(null);
    setDone(false);
    mountedAt.current = Date.now();
    void loadPage(true);
    // loadPage 依赖 next，这里只在筛选变化时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, favorite, query]);

  // 无限滚动
  useEffect(() => {
    const el = sentinel.current;
    if (!el || done) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loading && next) void loadPage(false);
    }, { rootMargin: '600px' });
    observer.observe(el);
    return () => observer.disconnect();
    // ready：首屏贴底之后才开始往上加载，否则一打开顶部哨兵就在视野里
  }, [loadPage, loading, next, done, ready]);

  // 滚动由这里接管（浏览器自带的滚动锚定会和下面的补偿叠加）
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overflowAnchor;
    root.style.overflowAnchor = 'none';
    let frame = 0;
    const onScroll = () => {
      atBottom.current = window.innerHeight + window.scrollY >= root.scrollHeight - 160;
      if (selfScroll.current) {
        selfScroll.current = false;
        return;
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(recordAnchor);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.style.overflowAnchor = previous;
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  const toBottom = (smooth = false) => {
    selfScroll.current = !smooth;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  /** 记下视口里第一张卡片（顶部导航以下）的位置 */
  function recordAnchor() {
    const cards = feedRef.current?.querySelectorAll('[data-feed-card]') ?? [];
    for (const el of cards) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > 80) {
        anchor.current = { el, top: rect.top };
        return;
      }
    }
    anchor.current = null;
  }

  /** 把锚点卡片挪回记下的位置 */
  function restoreAnchor() {
    const saved = anchor.current;
    if (!saved || !saved.el.isConnected) return;
    const delta = saved.el.getBoundingClientRect().top - saved.top;
    if (Math.abs(delta) > 0.5) {
      selfScroll.current = true;
      window.scrollBy(0, delta);
    }
  }

  // 内容高度变化（插入更早的作品、图片加载、卡片渲染）：在底部就贴底，否则保持视线
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (stickBottom.current || atBottom.current) toBottom();
      else restoreAnchor();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const search = useDebouncedCallback((value: string) => setQuery(value.trim()), 350);

  // 新提交的任务（SSE 推来的）出现在最下面
  const list = useMemo(() => {
    const seen = new Set(feedIds);
    const live = Object.values(tasks)
      .filter((task) => !seen.has(task.id) && !task.link.storyId && task.createdAt >= mountedAt.current - 5000)
      .filter((task) => kind === 'all' || (kind === 'video') === isVideoTask(task))
      .filter((task) => !query || task.prompt.includes(query))
      .filter(() => !favorite)
      .sort((a, b) => b.createdAt - a.createdAt);
    return [...live, ...feedIds.map((id) => tasks[id]).filter((t): t is Task => Boolean(t))];
  }, [tasks, feedIds, kind, favorite, query]);

  // 从早到晚排：最早的在上面，最新的在下面
  const groups = useMemo(() => {
    const result: { label: string; items: Task[] }[] = [];
    for (const task of [...list].reverse()) {
      const label = dayLabel(task.createdAt);
      const last = result.at(-1);
      if (last?.label === label) last.items.push(task);
      else result.push({ label, items: [task] });
    }
    return result;
  }, [list]);

  // 列表变化后调整滚动：加载了更早的一页 → 保持视线位置；首屏 / 新提交 → 贴到底部
  const newest = list[0]?.id;
  const lastNewest = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (stickBottom.current && list.length) {
      toBottom();
      stickBottom.current = false;
      atBottom.current = true;
      // 等这一帧布局稳定后再允许往上加载更早的
      requestAnimationFrame(() => setReady(true));
    } else if (newest && lastNewest.current && newest !== lastNewest.current) {
      toBottom(true);
    } else restoreAnchor();
    lastNewest.current = newest;
  }, [list, newest]);

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-56px-76px)] max-w-5xl flex-col px-4 pt-5 sm:px-6 md:min-h-dvh md:pt-8">
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-xl font-semibold tracking-tight">创作</h1>
        <Segmented
          size="sm"
          label="按类型筛选"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: '全部' },
            { value: 'image', label: '图片' },
            { value: 'video', label: '视频' },
          ]}
        />
        <button className="chip !h-7 !text-xs" data-active={favorite} onClick={() => setFavorite(!favorite)}>
          <Heart className={cx('size-3.5', favorite && 'fill-current')} /> 收藏
        </button>
        <label className="relative ml-auto w-full sm:w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
          <input
            className="field !h-8 !py-1 !pl-8 text-sm"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              search(e.target.value);
            }}
            placeholder="搜索提示词"
            aria-label="搜索提示词"
          />
        </label>
        <Link to="/studio/inspire" className="chip !h-8 !text-xs max-sm:hidden">
          <Lightbulb className="size-3.5" /> 灵感
        </Link>
      </div>

      <div ref={feedRef} className="flex flex-1 flex-col justify-end space-y-8 pb-8">
        <div ref={ready ? sentinel : undefined} className="flex justify-center py-2">
          {loading && <Spinner />}
          {done && list.length > PAGE && <p className="text-xs text-fg-3">已经到最早的作品了</p>}
        </div>
        {list.length === 0 && !loading ? (
          query || favorite ? (
            <Empty icon={<Search className="size-6" />} title="没有找到" hint="换个关键词，或者清除筛选" />
          ) : (
            <Empty
              icon={<ImageIcon className="size-6" />}
              title="开始你的第一次创作"
              hint="在下方写一句话，或者套用一个模板。"
              action={
                <Link to="/studio/inspire">
                  <Button variant="secondary" icon={<Lightbulb className="size-4" />}>
                    看看热门模板
                  </Button>
                </Link>
              }
            />
          )
        ) : (
          groups.map((group) => (
            <section key={group.label}>
              <h2 className="sticky top-14 z-10 -mx-1 mb-3 bg-ink/90 px-1 py-1.5 text-xs font-medium text-fg-3 backdrop-blur md:top-0">{group.label}</h2>
              <div className="space-y-8">
                {group.items.map((task) => (
                  <FeedCard key={task.id} task={task} onOpen={(asset, outputs) => setViewing({ asset, list: outputs })} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <div className="sticky bottom-[calc(76px+env(safe-area-inset-bottom))] z-20 -mx-1 pb-3 md:bottom-0 md:pb-6">
        <ComposerDock composer={composer} />
      </div>

      {viewing && <AssetViewer asset={viewing.asset} list={viewing.list} onClose={() => setViewing(null)} />}
      <CompareView />
    </div>
  );
}
