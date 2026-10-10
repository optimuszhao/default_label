import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, CloudOff, LayoutGrid, Loader2 } from 'lucide-react';
import type { StoryData } from '../../../../shared/types.ts';
import { Button, Spinner } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { cx, useDebouncedCallback } from '../../lib/util.ts';
import { CharactersTab } from './story/CharactersTab.tsx';
import { StoryContext, type StoryContextValue } from './story/context.tsx';
import { buildShotMedia, type Recipe } from './story/model.ts';
import { OverviewTab } from './story/OverviewTab.tsx';
import { PreviewTab } from './story/PreviewTab.tsx';
import { ScriptTab } from './story/ScriptTab.tsx';
import { SetupTab } from './story/SetupTab.tsx';
import { ShotsTab } from './story/ShotsTab.tsx';
import { STEPS, stepDone, storyStats, type StepId } from './story/steps.ts';
import { StructureTab } from './story/StructureTab.tsx';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export default function StoryEditor() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [title, setTitle] = useState('');
  const [data, setData] = useState<StoryData | null>(null);
  const [save, setSave] = useState<SaveState>('saved');
  const [sceneId, setSceneId] = useState<string | null>(null);
  const assets = useStore((s) => s.assets);
  const tasks = useStore((s) => s.tasks);
  const upsertAssets = useStore((s) => s.upsertAssets);
  const upsertTasks = useStore((s) => s.upsertTasks);
  const latest = useRef<{ title: string; data: StoryData | null }>({ title: '', data: null });

  useEffect(() => {
    let alive = true;
    setData(null);
    void (async () => {
      try {
        const story = await api.story(id);
        if (!alive) return;
        setTitle(story.title);
        setData(story.data);
        latest.current = { title: story.title, data: story.data };
        setSceneId(story.data.chapters[0]?.scenes[0]?.id ?? null);
        const [storyAssets, recent, storyTasks] = await Promise.all([
          api.assets({ storyId: id, limit: 500 }),
          api.assets({ limit: 300 }),
          api.tasks({ storyId: id, limit: 1000 }),
        ]);
        upsertAssets([...recent, ...storyAssets]);
        upsertTasks(storyTasks);
      } catch (error) {
        reportError(error);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, upsertAssets, upsertTasks]);

  const persist = useCallback(async () => {
    const { title: t, data: d } = latest.current;
    if (!d) return;
    setSave('saving');
    try {
      await api.saveStory(id, t.trim() || '未命名故事', d);
      setSave((state) => (state === 'saving' ? 'saved' : state));
    } catch (error) {
      setSave('error');
      reportError(error);
    }
  }, [id]);

  const scheduleSave = useDebouncedCallback(() => void persist(), 800);

  const update = useCallback(
    (recipe: Recipe) => {
      setData((prev) => {
        if (!prev) return prev;
        const next = recipe(prev);
        latest.current.data = next;
        return next;
      });
      setSave('dirty');
      scheduleSave();
    },
    [scheduleSave],
  );

  const changeTitle = (value: string) => {
    setTitle(value);
    latest.current.title = value;
    setSave('dirty');
    scheduleSave();
  };

  // 离开页面前若有未保存的修改，用 keepalive 请求兜底保存
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const flush = () => {
      const { title: t, data: d } = latest.current;
      if (!d || saveRef.current === 'saved') return;
      void fetch(`/api/stories/${id}`, {
        method: 'PUT',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: t.trim() || '未命名故事', data: d }),
      });
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [id]);

  const media = useMemo(() => (data ? buildShotMedia(id, assets, tasks, data) : new Map()), [id, assets, tasks, data]);

  const context = useMemo<StoryContextValue | null>(
    () => (data ? { storyId: id, data, update, media, sceneId, setSceneId } : null),
    [id, data, update, media, sceneId],
  );

  if (!context || !data) {
    return (
      <div className="flex min-h-[60dvh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const stats = storyStats(data, media);
  // 新故事从第 1 步开始，已有内容的故事默认打开总览
  const tab = (params.get('tab') as StepId) || (data.outline.trim() ? 'overview' : 'setup');
  const go = (value: StepId, targetScene?: string) => {
    if (targetScene) setSceneId(targetScene);
    setParams({ tab: value }, { replace: true });
    window.scrollTo({ top: 0 });
  };
  const stepIndex = STEPS.findIndex((step) => step.id === tab);
  const step = STEPS[stepIndex];
  const prev = STEPS[stepIndex - 1];
  const next = STEPS[stepIndex + 1];

  return (
    <StoryContext.Provider value={context}>
      <div className="mx-auto max-w-[88rem] px-4 py-4 sm:px-6 md:py-6">
        {/* 标题栏 */}
        <div className="flex items-center gap-2">
          <Link to="/studio/stories" className="flex size-8 shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-white/[0.06] hover:text-fg" aria-label="返回故事列表">
            <ArrowLeft className="size-4" />
          </Link>
          <input
            value={title}
            onChange={(e) => changeTitle(e.target.value)}
            maxLength={80}
            className="min-w-0 flex-1 bg-transparent text-lg font-semibold tracking-tight focus:outline-none sm:text-xl"
            aria-label="故事名称"
          />
          <span className="hidden font-mono text-[11px] text-fg-3 md:inline">
            {stats.chapters} 章 · {stats.scenes} 场 · {stats.shots} 镜 · 关键帧 {stats.keyframes}/{stats.shots}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 pl-2 text-xs text-fg-3">
            {save === 'saving' && <Loader2 className="size-3.5 animate-spin" />}
            {save === 'saved' && <Check className="size-3.5 text-ok" />}
            {save === 'error' && <CloudOff className="size-3.5 text-danger" />}
            <span className="hidden sm:inline">{{ saved: '已保存', dirty: '编辑中', saving: '保存中', error: '保存失败' }[save]}</span>
          </span>
        </div>

        {/* 步骤条 */}
        <div className="sticky top-14 z-20 -mx-4 mt-3 border-b border-line bg-ink/90 px-4 backdrop-blur-xl sm:-mx-6 sm:px-6 md:top-0">
          <nav className="no-scrollbar flex items-center gap-1 overflow-x-auto py-2" aria-label="创作步骤">
            <button
              onClick={() => go('overview')}
              className={cx(
                'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors',
                tab === 'overview' ? 'bg-white/[0.08] text-fg' : 'text-fg-3 hover:text-fg-2',
              )}
            >
              <LayoutGrid className="size-3.5" /> 总览
            </button>
            <span className="mx-1 h-4 w-px shrink-0 bg-line" />
            {STEPS.map((item, index) => {
              const done = stepDone(item.id, data, stats);
              const active = tab === item.id;
              return (
                <div key={item.id} className="flex shrink-0 items-center">
                  {index > 0 && <span className={cx('mx-0.5 h-px w-3 sm:w-5', done ? 'bg-accent/60' : 'bg-line')} />}
                  <button
                    onClick={() => go(item.id)}
                    aria-current={active ? 'step' : undefined}
                    className={cx(
                      'flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors',
                      active ? 'bg-white/[0.08] text-fg' : done ? 'text-fg-2 hover:text-fg' : 'text-fg-3 hover:text-fg-2',
                    )}
                  >
                    <span
                      className={cx(
                        'flex size-[18px] items-center justify-center rounded font-mono text-[10px]',
                        done ? 'bg-accent text-white' : active ? 'border border-accent text-accent' : 'border border-line-strong',
                      )}
                    >
                      {done ? <Check className="size-3" /> : index + 1}
                    </span>
                    {item.label}
                  </button>
                </div>
              );
            })}
          </nav>
        </div>

        {/* 当前步骤说明 */}
        {step && (
          <div className="mt-4 mb-4 flex items-baseline gap-3">
            <h2 className="shrink-0 text-base font-semibold">
              <span className="mr-1.5 font-mono text-xs text-accent">{String(stepIndex + 1).padStart(2, '0')}</span>
              {step.label}
            </h2>
            <p className="truncate text-xs text-fg-3 sm:text-[13px]">{step.hint}</p>
          </div>
        )}

        <div className={cx(!step && 'mt-4')}>
          {tab === 'overview' && <OverviewTab go={go} />}
          {tab === 'setup' && <SetupTab title={title} onTitle={changeTitle} />}
          {tab === 'characters' && <CharactersTab />}
          {tab === 'structure' && <StructureTab onOpenScene={(sid) => go('script', sid)} />}
          {tab === 'script' && <ScriptTab onGoShots={() => go('shots')} />}
          {tab === 'shots' && <ShotsTab />}
          {tab === 'preview' && <PreviewTab />}
        </div>

        {/* 上一步 / 下一步 */}
        {step && (
          <div className="mt-8 flex items-center justify-between gap-3 border-t border-line pt-4">
            {prev ? (
              <Button variant="ghost" onClick={() => go(prev.id)}>
                <ArrowLeft className="size-4" /> {prev.label}
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => go('overview')}>
                <LayoutGrid className="size-4" /> 总览
              </Button>
            )}
            {next ? (
              <Button variant={stepDone(step.id, data, stats) ? 'brand' : 'secondary'} onClick={() => go(next.id)}>
                下一步：{next.label} <ArrowRight className="size-4" />
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => go('overview')}>
                返回总览 <LayoutGrid className="size-4" />
              </Button>
            )}
          </div>
        )}
      </div>
    </StoryContext.Provider>
  );
}
