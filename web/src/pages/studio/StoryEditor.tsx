import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, BookOpenText, Check, Clapperboard, CloudOff, Film, Loader2, ScrollText, Users } from 'lucide-react';
import type { StoryData } from '../../../../shared/types.ts';
import { Spinner } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { cx, useDebouncedCallback } from '../../lib/util.ts';
import { CharactersTab } from './story/CharactersTab.tsx';
import { StoryContext, type StoryContextValue } from './story/context.tsx';
import { buildShotMedia, flattenShots, type Recipe } from './story/model.ts';
import { PreviewTab } from './story/PreviewTab.tsx';
import { ScriptTab } from './story/ScriptTab.tsx';
import { SetupTab } from './story/SetupTab.tsx';
import { ShotsTab } from './story/ShotsTab.tsx';

type Tab = 'setup' | 'characters' | 'script' | 'shots' | 'preview';

const TABS: { value: Tab; label: string; icon: typeof BookOpenText }[] = [
  { value: 'setup', label: '设定与大纲', icon: BookOpenText },
  { value: 'characters', label: '角色', icon: Users },
  { value: 'script', label: '章节剧本', icon: ScrollText },
  { value: 'shots', label: '分镜', icon: Clapperboard },
  { value: 'preview', label: '成片预览', icon: Film },
];

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export default function StoryEditor() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'setup';
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

  const shotCount = flattenShots(data).length;
  const setTab = (value: Tab) => {
    setParams({ tab: value }, { replace: true });
    window.scrollTo({ top: 0 });
  };

  return (
    <StoryContext.Provider value={context}>
      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 md:py-8">
        <div className="flex items-center gap-3">
          <Link to="/studio/stories" className="flex size-9 shrink-0 items-center justify-center rounded-xl text-fg-2 hover:bg-white/[0.06] hover:text-fg" aria-label="返回故事列表">
            <ArrowLeft className="size-5" />
          </Link>
          <input
            value={title}
            onChange={(e) => changeTitle(e.target.value)}
            maxLength={80}
            className="min-w-0 flex-1 bg-transparent text-xl font-semibold tracking-tight focus:outline-none sm:text-2xl"
            aria-label="故事名称"
          />
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-3">
            {save === 'saving' && <Loader2 className="size-3.5 animate-spin" />}
            {save === 'saved' && <Check className="size-3.5 text-ok" />}
            {save === 'error' && <CloudOff className="size-3.5 text-danger" />}
            <span className="hidden sm:inline">
              {{ saved: '已保存', dirty: '编辑中', saving: '保存中', error: '保存失败' }[save]}
            </span>
          </span>
        </div>

        <div className="sticky top-14 z-20 -mx-4 mt-4 bg-ink/85 px-4 py-2 backdrop-blur-xl sm:-mx-6 sm:px-6 md:top-0">
          <div className="no-scrollbar flex gap-1 overflow-x-auto">
            {TABS.map((item, index) => (
              <button
                key={item.value}
                onClick={() => setTab(item.value)}
                className={cx(
                  'flex h-9 shrink-0 items-center gap-2 rounded-xl px-3 text-sm transition-colors',
                  tab === item.value ? 'bg-white/[0.1] text-fg' : 'text-fg-3 hover:text-fg-2',
                )}
              >
                <span className={cx('font-mono text-[10px]', tab === item.value ? 'text-cyan' : 'text-fg-3')}>{index + 1}</span>
                <item.icon className="size-4" />
                {item.label}
                {item.value === 'shots' && shotCount > 0 && <span className="text-[11px] text-fg-3">{shotCount}</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          {tab === 'setup' && <SetupTab title={title} onTitle={changeTitle} />}
          {tab === 'characters' && <CharactersTab />}
          {tab === 'script' && <ScriptTab onGoShots={() => setTab('shots')} />}
          {tab === 'shots' && <ShotsTab />}
          {tab === 'preview' && <PreviewTab />}
        </div>
      </div>
    </StoryContext.Provider>
  );
}
