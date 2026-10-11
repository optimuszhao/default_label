import { memo } from 'react';
import { ArrowRight, BookOpenText, Clapperboard, Film, Image as ImageIcon, MessageSquareQuote, Plus, UserRound } from 'lucide-react';
import type { Chapter, Scene } from '../../../../../shared/types.ts';
import { Button, Media } from '../../../components/ui.tsx';
import { cssRatio } from '../../../lib/presets.ts';
import { useStore } from '../../../lib/store.ts';
import { cx, formatDuration } from '../../../lib/util.ts';
import { useStory } from './context.tsx';
import { EMPTY_MEDIA } from './model.ts';
import { ProgressBoard } from './ProgressBoard.tsx';
import { nextStep, STEPS, stepDone, storyStats, type StepId } from './steps.ts';

// 总览里的步骤清单按通用步骤显示；模板专属的排版步骤在步骤条里

type Go = (step: StepId, sceneId?: string) => void;

function Stat({ label, value, total, icon }: { label: string; value: number | string; total?: number; icon: React.ReactNode }) {
  const ratio = total ? Number(value) / total : null;
  return (
    <div className="bg-ink-1 p-3.5">
      <div className="flex items-center gap-1.5 text-xs text-fg-3">
        {icon}
        {label}
      </div>
      <p className="mt-1.5 font-mono text-xl font-semibold">
        {value}
        {total !== undefined && <span className="text-sm font-normal text-fg-3">/{total}</span>}
      </p>
      {ratio !== null && (
        <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full bg-accent" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

const SceneRow = memo(function SceneRow({ scene, go }: { scene: Scene; go: Go }) {
  const { data, media } = useStory();
  const frames = scene.shots.map((shot) => media.get(shot.id) ?? EMPTY_MEDIA);
  const done = frames.filter((m) => m.keyframe).length;
  return (
    <div className="group grid gap-3 px-4 py-3 transition-colors hover:bg-white/[0.02] md:grid-cols-[13rem_minmax(0,1fr)]">
      <button className="min-w-0 text-left" onClick={() => go('script', scene.id)}>
        <p className="truncate text-[13px] font-medium group-hover:text-accent">{scene.title}</p>
        <p className="mt-0.5 truncate text-xs text-fg-3">
          {[scene.location, scene.time].filter(Boolean).join(' · ') || '未设置地点时间'}
        </p>
        <p className="mt-1.5 flex gap-3 font-mono text-[11px] text-fg-3">
          <span>{scene.dialogue.length} 句台词</span>
          <span className={cx(scene.shots.length > 0 && done === scene.shots.length && 'text-accent')}>
            {done}/{scene.shots.length} 镜
          </span>
        </p>
      </button>
      {scene.shots.length ? (
        <button onClick={() => go('shots', scene.id)} className="no-scrollbar flex gap-1.5 overflow-x-auto text-left" aria-label={`查看 ${scene.title} 的分镜`}>
          {scene.shots.map((shot, index) => {
            const m = frames[index];
            return (
              <span
                key={shot.id}
                className="dots-bg relative h-14 shrink-0 overflow-hidden rounded-md border border-line bg-ink-2"
                style={{ aspectRatio: cssRatio(data.aspectRatio) }}
              >
                {m.keyframe && <Media asset={m.keyframe} />}
                <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 font-mono text-[9px] text-fg-2">#{index + 1}</span>
                {m.video && <Film className="absolute top-1 right-1 size-3 text-white drop-shadow" />}
                {(m.keyframeTask || m.videoTask) && <span className="absolute top-1 left-1 size-1.5 animate-pulse rounded-full bg-accent" />}
              </span>
            );
          })}
        </button>
      ) : (
        <button
          onClick={() => go('shots', scene.id)}
          className="flex h-14 items-center justify-center gap-1.5 rounded-md border border-dashed border-line text-xs text-fg-3 hover:border-accent/50 hover:text-fg"
        >
          <Plus className="size-3.5" /> 设计分镜
        </button>
      )}
    </div>
  );
});

function ChapterBlock({ chapter, index, go }: { chapter: Chapter; index: number; go: Go }) {
  const shots = chapter.scenes.reduce((sum, s) => sum + s.shots.length, 0);
  return (
    <section className="panel cv-auto overflow-hidden">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="font-mono text-[11px] text-accent">CH.{String(index + 1).padStart(2, '0')}</span>
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{chapter.title}</p>
        <span className="font-mono text-[11px] text-fg-3">
          {chapter.scenes.length} 场 · {shots} 镜
        </span>
      </header>
      {chapter.summary && <p className="border-b border-line px-4 py-2 text-xs leading-relaxed text-fg-3">{chapter.summary}</p>}
      <div className="divide-y divide-line">
        {chapter.scenes.map((scene) => (
          <SceneRow key={scene.id} scene={scene} go={go} />
        ))}
        {chapter.scenes.length === 0 && <p className="px-4 py-4 text-xs text-fg-3">这一章还没有场次</p>}
      </div>
    </section>
  );
}

export function OverviewTab({ go }: { go: Go }) {
  const { storyId, data, media } = useStory();
  const assets = useStore((s) => s.assets);
  const stats = storyStats(data, media);
  const next = nextStep(data, stats);
  const recent = Object.values(assets)
    .filter((a) => a.storyId === storyId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 9);

  return (
    <div className="space-y-4">
      {/* 继续创作引导 */}
      {next && (
        <div className="panel flex flex-col gap-3 border-accent/30 bg-accent/[0.06] p-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-accent">下一步 · 第 {STEPS.indexOf(next) + 1} 步</p>
            <p className="mt-0.5 text-sm font-medium">{next.label}</p>
            <p className="mt-0.5 text-xs text-fg-3">{next.hint}</p>
          </div>
          <Button variant="brand" onClick={() => go(next.id)}>
            继续创作 <ArrowRight className="size-4" />
          </Button>
        </div>
      )}

      {stats.shots > 0 && <ProgressBoard go={go} />}

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="章节" value={stats.chapters} icon={<BookOpenText className="size-3.5" />} />
        <Stat label="场次" value={stats.scenes} icon={<Clapperboard className="size-3.5" />} />
        <Stat label="台词" value={stats.dialogue} icon={<MessageSquareQuote className="size-3.5" />} />
        <Stat label="时长" value={formatDuration(stats.duration)} icon={<Film className="size-3.5" />} />
        <Stat label="关键帧" value={stats.keyframes} total={stats.shots} icon={<ImageIcon className="size-3.5" />} />
        <Stat label="视频" value={stats.videos} total={stats.shots} icon={<Film className="size-3.5" />} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-3">
          {data.chapters.map((chapter, index) => (
            <ChapterBlock key={chapter.id} chapter={chapter} index={index} go={go} />
          ))}
          {data.chapters.length === 0 && (
            <div className="panel dots-bg flex flex-col items-center px-6 py-14 text-center">
              <BookOpenText className="size-6 text-fg-3" />
              <p className="mt-3 text-sm font-medium">故事结构还是空的</p>
              <p className="mt-1 max-w-sm text-xs text-fg-3">完成设定和大纲后，在「章节场次」里拆分结构，这里会显示整部故事的全貌。</p>
              <Button className="mt-4" variant="primary" size="sm" onClick={() => go(next?.id ?? 'setup')}>
                从第 {next ? STEPS.indexOf(next) + 1 : 1} 步开始
              </Button>
            </div>
          )}
        </div>

        <aside className="space-y-3">
          <section className="panel p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[13px] font-medium">角色 · {data.characters.length}</h3>
              <button className="text-xs text-fg-3 hover:text-fg" onClick={() => go('characters')}>管理</button>
            </div>
            {data.characters.length ? (
              <div className="grid grid-cols-4 gap-2">
                {data.characters.map((c) => {
                  const ref = c.referenceAssetId ? assets[c.referenceAssetId] : null;
                  return (
                    <button key={c.id} onClick={() => go('characters')} className="min-w-0 text-center">
                      <span className="dots-bg mx-auto flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-md border border-line bg-ink-2">
                        {ref ? <Media asset={ref} /> : <UserRound className="size-4 text-fg-3" />}
                      </span>
                      <span className="mt-1 block truncate text-[11px] text-fg-2">{c.name}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-fg-3">还没有角色</p>
            )}
          </section>

          <section className="panel space-y-2 p-4 text-xs">
            <h3 className="text-[13px] font-medium">故事设定</h3>
            <p className="leading-relaxed text-fg-2">{data.logline || '还没有一句话故事'}</p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[data.genre, data.tone, data.aspectRatio].filter(Boolean).map((tag) => (
                <span key={tag} className="rounded border border-line px-1.5 py-0.5 text-fg-3">{tag}</span>
              ))}
            </div>
            <p className="line-clamp-2 text-fg-3">画风：{data.visualStyle || '未设置'}</p>
          </section>

          <section className="panel p-4">
            <h3 className="mb-3 text-[13px] font-medium">最近素材</h3>
            {recent.length ? (
              <div className="grid grid-cols-3 gap-1.5">
                {recent.map((asset) => (
                  <span key={asset.id} className="relative aspect-square overflow-hidden rounded-md bg-ink-2">
                    <Media asset={asset} />
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-fg-3">生成的关键帧和视频会出现在这里</p>
            )}
          </section>

          <section className="panel p-4">
            <h3 className="mb-2 text-[13px] font-medium">创作进度</h3>
            <ol className="space-y-1">
              {STEPS.map((step, index) => {
                const done = stepDone(step.id, data, stats);
                return (
                  <li key={step.id}>
                    <button onClick={() => go(step.id)} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-white/[0.04]">
                      <span className={cx('flex size-4 items-center justify-center rounded font-mono text-[9px]', done ? 'bg-accent text-white' : 'bg-white/[0.08] text-fg-3')}>
                        {done ? '✓' : index + 1}
                      </span>
                      <span className={done ? 'text-fg-2' : 'text-fg-3'}>{step.label}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}
