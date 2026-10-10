import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CloudOff, History, LayoutGrid, Loader2 } from 'lucide-react';
import type { Story, StoryData } from '../../../../shared/types.ts';
import { Button, IconButton, Spinner } from '../../components/ui.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { cx, useDebouncedCallback } from '../../lib/util.ts';
import { CharactersTab } from './story/CharactersTab.tsx';
import { StoryContext, type StoryContextValue } from './story/context.tsx';
import { clearDraft, draftDiffers, readDraft, writeDraft, type StoryDraft } from './story/draft.ts';
import { HistoryDialog } from './story/HistoryDialog.tsx';
import { buildShotMedia, type Recipe } from './story/model.ts';
import { OverviewTab } from './story/OverviewTab.tsx';
import { PreviewTab } from './story/PreviewTab.tsx';
import { ScriptTab } from './story/ScriptTab.tsx';
import { SetupTab } from './story/SetupTab.tsx';
import { ShotsTab } from './story/ShotsTab.tsx';
import { STEPS, stepDone, storyStats, type StepId } from './story/steps.ts';
import { StructureTab } from './story/StructureTab.tsx';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

/** keepalive 请求体超过 64 KB 会被浏览器拒绝，留点余量；超出部分靠本地草稿兜底 */
const KEEPALIVE_LIMIT = 60_000;

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
  const toast = useStore((s) => s.toast);
  const latest = useRef<{ title: string; data: StoryData | null }>({ title: '', data: null });
  /** 当前编辑所基于的服务器版本号 */
  const revRef = useRef(0);
  /** 每次修改 +1，用来判断保存期间有没有新的修改 */
  const editSeq = useRef(0);
  const conflictRef = useRef(false);
  /** 打开时发现的、基于旧版本的本地草稿，等用户决定 */
  const [staleDraft, setStaleDraft] = useState<StoryDraft | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const applyStory = useCallback((story: Pick<Story, 'title' | 'data' | 'rev'>) => {
    setTitle(story.title);
    setData(story.data);
    latest.current = { title: story.title, data: story.data };
    revRef.current = story.rev;
  }, []);

  const saveDraft = useCallback(() => {
    const { title: t, data: d } = latest.current;
    if (d) writeDraft(id, { baseRev: revRef.current, title: t, data: d, savedAt: Date.now() });
  }, [id]);

  const persist = useCallback(async (): Promise<boolean> => {
    const { title: t, data: d } = latest.current;
    if (!d || conflictRef.current) return false;
    const seq = editSeq.current;
    saveDraft();
    setSave('saving');
    try {
      const result = await api.saveStory(id, t.trim() || '未命名故事', d, revRef.current);
      revRef.current = result.rev;
      if (editSeq.current === seq) {
        clearDraft(id);
        setSave('saved');
      } else {
        // 保存期间又有修改：草稿里留着最新内容，等下一次保存
        saveDraft();
        setSave('dirty');
      }
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        conflictRef.current = true;
        setSave('conflict');
      } else {
        setSave('error');
        reportError(error);
      }
      return false;
    }
  }, [id, saveDraft]);

  const scheduleSave = useDebouncedCallback(() => void persist(), 800);

  useEffect(() => {
    let alive = true;
    setData(null);
    setStaleDraft(null);
    conflictRef.current = false;
    editSeq.current = 0;
    setSave('saved');
    void (async () => {
      try {
        const story = await api.story(id);
        if (!alive) return;
        applyStory(story);
        setSceneId(story.data.chapters[0]?.scenes[0]?.id ?? null);
        // 上次没保存上去的修改：基于同一版本就直接重放，否则请用户决定
        const draft = readDraft(id);
        if (draft && !draftDiffers(draft, story.title, story.data)) clearDraft(id);
        else if (draft && draft.baseRev === story.rev) {
          setTitle(draft.title);
          setData(draft.data);
          latest.current = { title: draft.title, data: draft.data };
          editSeq.current++;
          setSave('dirty');
          scheduleSave();
          toast('已恢复上次未保存的修改', 'info');
        } else if (draft) {
          setStaleDraft(draft);
        }
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
    // scheduleSave 每次渲染都是新函数，这里只在切换故事时运行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, upsertAssets, upsertTasks, applyStory, toast]);

  const update = useCallback(
    (recipe: Recipe) => {
      setData((prev) => {
        if (!prev) return prev;
        const next = recipe(prev);
        latest.current.data = next;
        return next;
      });
      editSeq.current++;
      setSave((state) => (state === 'conflict' ? state : 'dirty'));
      scheduleSave();
    },
    [scheduleSave],
  );

  const changeTitle = (value: string) => {
    setTitle(value);
    latest.current.title = value;
    editSeq.current++;
    setSave((state) => (state === 'conflict' ? state : 'dirty'));
    scheduleSave();
  };

  /** 冲突时：放弃本地修改，载入服务器上的最新版本 */
  const loadLatest = async () => {
    try {
      const story = await api.story(id);
      applyStory(story);
      clearDraft(id);
      conflictRef.current = false;
      setStaleDraft(null);
      setSave('saved');
    } catch (error) {
      reportError(error);
    }
  };

  /** 冲突时：用本地版本覆盖服务器（服务器上的旧内容会先存进历史版本） */
  const keepMine = async (draft?: StoryDraft) => {
    try {
      const story = await api.story(id);
      revRef.current = story.rev;
      if (draft) {
        setTitle(draft.title);
        setData(draft.data);
        latest.current = { title: draft.title, data: draft.data };
      }
      conflictRef.current = false;
      setStaleDraft(null);
      editSeq.current++;
      await persist();
    } catch (error) {
      reportError(error);
    }
  };

  // 离开页面前：未保存的修改先写进本地草稿，再用 keepalive 请求尽量保存上去
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const flush = () => {
      const { title: t, data: d } = latest.current;
      if (!d || saveRef.current === 'saved') return;
      saveDraft();
      if (conflictRef.current) return;
      const body = JSON.stringify({ title: t.trim() || '未命名故事', data: d, baseRev: revRef.current });
      if (body.length > KEEPALIVE_LIMIT) return;
      void fetch(`/api/stories/${id}`, {
        method: 'PUT',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body,
      }).then((response) => {
        if (response.ok) clearDraft(id);
      }, () => undefined);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [id, saveDraft]);

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
          <span
            role="status"
            aria-label={{ saved: '已保存', dirty: '编辑中', saving: '保存中', error: '保存失败', conflict: '有冲突' }[save]}
            className="flex shrink-0 items-center gap-1.5 pl-2 text-xs text-fg-3"
          >
            {save === 'saving' && <Loader2 className="size-3.5 animate-spin" />}
            {save === 'saved' && <Check className="size-3.5 text-ok" />}
            {save === 'error' && <CloudOff className="size-3.5 text-danger" />}
            {save === 'conflict' && <AlertTriangle className="size-3.5 text-warn" />}
            <span className="hidden sm:inline">
              {{ saved: '已保存', dirty: '编辑中', saving: '保存中', error: '保存失败', conflict: '有冲突' }[save]}
            </span>
          </span>
          <IconButton label="历史版本" onClick={() => setHistoryOpen(true)}>
            <History className="size-4" />
          </IconButton>
        </div>

        {save === 'conflict' && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[13px]">
            <AlertTriangle className="size-4 shrink-0 text-warn" />
            <span className="min-w-0 flex-1">这个故事已在其他设备或标签页更新，你在这里的修改暂未保存。</span>
            <Button size="sm" variant="ghost" onClick={() => void loadLatest()}>
              载入最新版本
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void keepMine()}>
              保留我的修改
            </Button>
          </div>
        )}
        {staleDraft && save !== 'conflict' && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-white/[0.04] px-3 py-2 text-[13px]">
            <History className="size-4 shrink-0 text-fg-2" />
            <span className="min-w-0 flex-1">本机有一份未保存的修改，但服务器上的版本后来又更新过。</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                clearDraft(id);
                setStaleDraft(null);
              }}
            >
              丢弃本机修改
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void keepMine(staleDraft)}>
              恢复本机修改
            </Button>
          </div>
        )}

        <HistoryDialog
          storyId={id}
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          beforeRestore={async () => saveRef.current === 'saved' || (await persist())}
          onRestored={(story) => {
            applyStory(story);
            clearDraft(id);
            conflictRef.current = false;
            setSave('saved');
            toast('已恢复到所选版本', 'success');
          }}
        />

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
