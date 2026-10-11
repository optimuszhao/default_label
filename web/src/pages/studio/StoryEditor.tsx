import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CloudOff, Download, History, LayoutGrid, Loader2, Lock, Redo2, Undo2 } from 'lucide-react';
import { CompareView } from '../../components/CompareView.tsx';
import { Button, IconButton, Spinner } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { cx } from '../../lib/util.ts';
import { BatchDialog } from './story/BatchDialog.tsx';
import { CharactersTab } from './story/CharactersTab.tsx';
import { StoryContext, type StoryContextValue } from './story/context.tsx';
import { HistoryDialog } from './story/HistoryDialog.tsx';
import { buildShotMedia } from './story/model.ts';
import { OverviewTab } from './story/OverviewTab.tsx';
import { PreviewTab } from './story/PreviewTab.tsx';
import { ScriptTab } from './story/ScriptTab.tsx';
import { SetupTab } from './story/SetupTab.tsx';
import { ShotsTab } from './story/ShotsTab.tsx';
import { stepDone, stepsFor, storyStats, type StepId } from './story/steps.ts';
import { LayoutTab } from './story/LayoutTab.tsx';
import { findTemplate, type StoryTemplate } from '../../../../shared/story-templates.ts';
import { StructureTab } from './story/StructureTab.tsx';
import { useStorySync } from './story/sync.ts';

const SAVE_LABEL = { saved: '已保存', dirty: '编辑中', saving: '保存中', error: '保存失败', readonly: '只读' } as const;

export default function StoryEditor() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [sceneId, setSceneId] = useState<string | null>(null);
  const assets = useStore((s) => s.assets);
  const tasks = useStore((s) => s.tasks);
  const upsertAssets = useStore((s) => s.upsertAssets);
  const upsertTasks = useStore((s) => s.upsertTasks);
  const toast = useStore((s) => s.toast);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [series, setSeries] = useState<{ id: string; title: string; episodeNo: number | null } | null>(null);
  const [template, setTemplate] = useState<StoryTemplate | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const showSeries = async (seriesId: string | null, episodeNo: number | null) => {
    if (!seriesId) return setSeries(null);
    const list = await api.seriesList().catch(() => []);
    setSeries({ id: seriesId, title: list.find((item) => item.id === seriesId)?.title ?? '系列', episodeNo });
  };
  const sync = useStorySync(id);
  const { content, save, readOnly, load, update, setTitle, undo, redo, canUndo, canRedo } = sync;
  const title = content?.title ?? '';
  const data = content?.data ?? null;

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const story = await load();
        if (!alive || !story) return;
        const meta = story as unknown as { lastPosition?: { tab?: string; sceneId?: string | null }; seriesId?: string | null; episodeNo?: number | null; templateId?: string | null };
        setTemplate(findTemplate(meta.templateId));
        const position = meta.lastPosition;
        void showSeries(meta.seriesId ?? null, meta.episodeNo ?? null);
        setSceneId(position?.sceneId ?? story.data.chapters[0]?.scenes[0]?.id ?? null);
        if (!params.get('tab') && position?.tab) setParams({ tab: position.tab }, { replace: true });
        const [storyAssets, recent, storyTasks] = await Promise.all([api.storyMedia(id), api.assets({ limit: 120 }), api.tasks({ storyId: id, limit: 1000 })]);
        upsertAssets([...recent, ...storyAssets]);
        upsertTasks(storyTasks);
      } catch (error) {
        reportError(error);
      }
    })();
    return () => {
      alive = false;
    };
    // 只在切换故事时运行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 撤销 / 重做快捷键：在输入框里时交给浏览器自己的撤销
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // 记住上次编辑的位置（故事列表里"继续上次的位置"）
  const tabParam = params.get('tab');
  useEffect(() => {
    if (!tabParam || !content) return;
    const handle = setTimeout(() => void api.patchStory(id, { lastPosition: { tab: tabParam, sceneId } }).catch(() => undefined), 1500);
    return () => clearTimeout(handle);
  }, [id, tabParam, sceneId, content]);

  const media = useMemo(() => (data ? buildShotMedia(id, assets, tasks, data) : new Map()), [id, assets, tasks, data]);

  const context = useMemo<StoryContextValue | null>(
    () => (data ? { storyId: id, data, update, media, sceneId, setSceneId, flushNow: sync.flushNow } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, data, update, media, sceneId],
  );
  const changeTitle = setTitle;

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
  const steps = stepsFor(template);
  const stepIndex = steps.findIndex((step) => step.id === tab);
  const step = steps[stepIndex] ?? (tab === 'layout' ? { id: 'layout' as const, label: '图文排版', hint: '把镜头画面排成绘本、四格漫画或条漫，导出长图或打印成 PDF。' } : undefined);
  const prev = steps[stepIndex - 1];
  const next = steps[stepIndex + 1];

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
          {series && (
            <Link to={`/studio/series/${series.id}`} className="hidden shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] text-fg-2 hover:border-accent hover:text-fg sm:inline">
              {series.title}
              {series.episodeNo ? ` · 第 ${series.episodeNo} 集` : ''}
            </Link>
          )}
          <span className="hidden font-mono text-[11px] text-fg-3 md:inline">
            {stats.chapters} 章 · {stats.scenes} 场 · {stats.shots} 镜 · 关键帧 {stats.keyframes}/{stats.shots}
          </span>
          <IconButton label="撤销（⌘Z）" onClick={undo} disabled={!canUndo || Boolean(readOnly)}>
            <Undo2 className="size-4" />
          </IconButton>
          <IconButton label="重做（⇧⌘Z）" onClick={redo} disabled={!canRedo || Boolean(readOnly)}>
            <Redo2 className="size-4" />
          </IconButton>
          <span role="status" aria-label={SAVE_LABEL[save]} className="flex shrink-0 items-center gap-1.5 pl-1 text-xs text-fg-3">
            {save === 'saving' && <Loader2 className="size-3.5 animate-spin" />}
            {save === 'saved' && <Check className="size-3.5 text-ok" />}
            {save === 'error' && <CloudOff className="size-3.5 text-danger" />}
            {save === 'readonly' && <Lock className="size-3.5 text-warn" />}
            <span className="hidden sm:inline">{SAVE_LABEL[save]}</span>
          </span>
          <IconButton label="历史版本" onClick={() => setHistoryOpen(true)}>
            <History className="size-4" />
          </IconButton>
          <div className="relative">
            <IconButton label="导出" onClick={() => setExportOpen((v) => !v)} active={exportOpen}>
              <Download className="size-4" />
            </IconButton>
            {exportOpen && (
              <div className="glass absolute right-0 z-30 mt-1 w-52 rounded-xl border border-line-strong p-1 text-[13px] shadow-2xl" role="menu" onClick={() => setExportOpen(false)}>
                {[
                  ['剧本（Markdown）', `/api/stories/${id}/export/script.md`],
                  ['剧本（纯文本）', `/api/stories/${id}/export/script.txt`],
                  ['字幕（SRT）', `/api/stories/${id}/export/subtitles.srt`],
                  ['字幕（ASS）', `/api/stories/${id}/export/subtitles.ass`],
                  ['镜头表（CSV）', `/api/stories/${id}/export/shots.csv`],
                  ['全部关键帧（ZIP）', `/api/stories/${id}/export/keyframes.zip`],
                  ['故事包（.weave.zip，可导入）', `/api/stories/${id}/package`],
                ].map(([label, href]) => (
                  <a key={href} role="menuitem" href={href} className="block rounded-lg px-3 py-1.5 hover:bg-white/[0.08]">
                    {label}
                  </a>
                ))}
                <div className="my-1 h-px bg-line" />
                <a role="menuitem" href={`/print/stories/${id}?mode=storyboard`} target="_blank" rel="noreferrer" className="block rounded-lg px-3 py-1.5 hover:bg-white/[0.08]">
                  打印分镜表 / PDF
                </a>
                <button role="menuitem" onClick={() => go('layout')} className="block w-full rounded-lg px-3 py-1.5 text-left hover:bg-white/[0.08]">
                  图文排版（绘本 / 漫画）
                </button>
              </div>
            )}
          </div>
        </div>

        {readOnly && (
          <div className="mt-3 flex items-center gap-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[13px]">
            <AlertTriangle className="size-4 shrink-0 text-warn" />
            <span className="min-w-0 flex-1">{readOnly}</span>
          </div>
        )}
        {save === 'error' && !readOnly && (
          <div className="mt-3 flex items-center gap-3 rounded-lg border border-line bg-white/[0.04] px-3 py-2 text-[13px] text-fg-2">
            <CloudOff className="size-4 shrink-0 text-danger" />
            <span className="min-w-0 flex-1">暂时连不上服务器，修改已保存在本机，恢复联网后会自动提交。</span>
          </div>
        )}

        <HistoryDialog
          storyId={id}
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          beforeRestore={sync.flushNow}
          onRestored={() => {
            void load();
            toast('已恢复到所选版本', 'success');
          }}
        />

        <BatchDialog />
        <CompareView />

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
            {steps.map((item, index) => {
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
          {tab === 'setup' && (
            <SetupTab
              title={title}
              onTitle={changeTitle}
              seriesId={series?.id ?? null}
              onSeries={(seriesId) => void (async () => {
                const story = await api.story(id);
                await showSeries(seriesId, (story as unknown as { episodeNo?: number | null }).episodeNo ?? null);
                await load();
              })()}
            />
          )}
          {tab === 'characters' && <CharactersTab inSeries={Boolean(series)} />}
          {tab === 'structure' && <StructureTab onOpenScene={(sid) => go('script', sid)} />}
          {tab === 'script' && <ScriptTab onGoShots={() => go('shots')} />}
          {tab === 'shots' && <ShotsTab imageOnly={Boolean(template?.imageOnly)} />}
          {tab === 'layout' && <LayoutTab title={title} defaultKind={template?.layout ?? 'picture_book'} />}
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
