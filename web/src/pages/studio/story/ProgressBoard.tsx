// 进度看板（STY-10）：与目标时长的差距、剩余 GPU 时长和预计完成时间、按章节分段的进度条、"需要处理"列表
import { AlertTriangle, Clock, Film, Image as ImageIcon, Lock, Target, Zap } from 'lucide-react';
import { estimateSeconds } from '../../../../../shared/story-prompt.ts';
import { maxDuration } from '../../../../../shared/operator.ts';
import { Button } from '../../../components/ui.tsx';
import { useStore } from '../../../lib/store.ts';
import { cx, formatDuration } from '../../../lib/util.ts';
import { formatSeconds } from './BatchDialog.tsx';
import { useShotGenerator, useStory } from './context.tsx';
import { EMPTY_MEDIA, flattenShots } from './model.ts';
import type { StepId } from './steps.ts';

interface Issue {
  key: string;
  sceneId: string;
  label: string;
  message: string;
  tone: 'warn' | 'danger';
}

export function ProgressBoard({ go }: { go: (step: StepId, sceneId?: string) => void }) {
  const { storyId, data, media, update } = useStory();
  const tasks = useStore((s) => s.tasks);
  const caps = useStore((s) => s.capabilities);
  const generator = useShotGenerator();
  const shots = flattenShots(data);
  const maxSeconds = maxDuration(caps.video);

  const total = shots.length;
  let keyframes = 0;
  let videos = 0;
  let locked = 0;
  let remaining = 0;
  const issues: Issue[] = [];
  const failed = new Map<string, number>();
  let activeCount = 0;
  let activeSeconds = 0;
  for (const task of Object.values(tasks)) {
    if (task.link.storyId !== storyId) continue;
    if (['queued', 'running', 'paused'].includes(task.status)) {
      activeCount++;
      activeSeconds += estimateSeconds(task.type, task.params.duration) * (task.status === 'running' ? 1 - task.progress : 1);
    }
    if (task.status === 'failed' && task.link.shotId) failed.set(task.link.shotId, (failed.get(task.link.shotId) ?? 0) + 1);
  }
  for (const { shot, scene, number } of shots) {
    const m = media.get(shot.id) ?? EMPTY_MEDIA;
    const label = `#${shot.code || number} ${scene.title}`;
    if (m.keyframe) keyframes++;
    else if (!m.keyframeTask) remaining += estimateSeconds('t2i');
    if (m.video) videos++;
    else if (!m.videoTask) remaining += estimateSeconds('i2v', shot.duration);
    if (shot.locked) locked++;
    if (!shot.description.trim() && !shot.promptOverride?.trim()) issues.push({ key: `${shot.id}:desc`, sceneId: scene.id, label, message: '还没写画面描述', tone: 'warn' });
    if (shot.duration > maxSeconds) issues.push({ key: `${shot.id}:long`, sceneId: scene.id, label, message: `${shot.duration} 秒超过单段上限 ${maxSeconds} 秒，建议拆分`, tone: 'warn' });
    if (shot.review === 'redo') issues.push({ key: `${shot.id}:redo`, sceneId: scene.id, label, message: '标记为待返工', tone: 'danger' });
    const fails = failed.get(shot.id);
    if (fails && (!m.keyframe || !m.video) && !m.keyframeTask && !m.videoTask) {
      issues.push({ key: `${shot.id}:fail`, sceneId: scene.id, label, message: `有 ${fails} 个任务失败${!m.keyframe ? '，下游视频等待上游关键帧' : ''}`, tone: 'danger' });
    }
  }
  const duration = shots.reduce((sum, item) => sum + item.shot.duration, 0);
  const target = data.targetDuration ?? 0;
  const eta = (activeSeconds + remaining) / Math.max(1, 2);

  return (
    <section className="panel space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">进度看板</h3>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<ImageIcon className="size-3.5" />} disabled={!total} onClick={() => generator.batch({ type: 'all' }, 'keyframe')}>
            补齐关键帧
          </Button>
          <Button size="sm" variant="brand" icon={<Zap className="size-3.5" />} disabled={!total} onClick={() => generator.batch({ type: 'all' }, 'keyframe_then_video')}>
            先关键帧再视频
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
        <div>
          <p className="flex items-center gap-1 text-xs text-fg-3">
            <Target className="size-3.5" /> 时长 / 目标
          </p>
          <p className="mt-1 font-mono">
            {formatDuration(duration)}
            {target ? <span className="text-fg-3"> / {formatDuration(target)}</span> : null}
          </p>
          <label className="mt-1 flex items-center gap-1 text-[11px] text-fg-3">
            目标
            <input
              type="number"
              min={0}
              className="field !h-6 !w-16 !px-1.5 !py-0 text-[11px]"
              value={target ? Math.round(target / 60) : ''}
              placeholder="分钟"
              onChange={(e) => update((d) => ({ ...d, targetDuration: e.target.value ? Math.max(0, Number(e.target.value)) * 60 : undefined }))}
              aria-label="目标时长（分钟）"
            />
            分钟
            {target > 0 && <span className={cx(duration >= target ? 'text-ok' : 'text-warn')}>{duration >= target ? '已达到' : `差 ${formatDuration(target - duration)}`}</span>}
          </label>
        </div>
        <div>
          <p className="flex items-center gap-1 text-xs text-fg-3">
            <ImageIcon className="size-3.5" /> 关键帧 · 视频
          </p>
          <p className="mt-1 font-mono">
            {keyframes}/{total} · {videos}/{total}
          </p>
          <p className="mt-1 flex items-center gap-1 text-[11px] text-fg-3">
            <Lock className="size-3" /> 定稿 {locked}
          </p>
        </div>
        <div>
          <p className="flex items-center gap-1 text-xs text-fg-3">
            <Film className="size-3.5" /> 进行中
          </p>
          <p className="mt-1 font-mono">{activeCount} 个任务</p>
        </div>
        <div>
          <p className="flex items-center gap-1 text-xs text-fg-3">
            <Clock className="size-3.5" /> 剩余 GPU 时长
          </p>
          <p className="mt-1 font-mono">{formatSeconds(activeSeconds + remaining)}</p>
          <p className="mt-1 text-[11px] text-fg-3">全部做完约 {formatSeconds(eta)}</p>
        </div>
      </div>

      {data.chapters.length > 0 && (
        <div className="space-y-2">
          {data.chapters.map((chapter, index) => {
            const own = shots.filter((item) => item.chapter.id === chapter.id);
            const k = own.filter((item) => media.get(item.shot.id)?.keyframe).length;
            const v = own.filter((item) => media.get(item.shot.id)?.video).length;
            const n = Math.max(1, own.length);
            return (
              <div key={chapter.id} className="grid grid-cols-[8rem_minmax(0,1fr)_4.5rem] items-center gap-3 text-xs">
                <span className="truncate text-fg-2">
                  {index + 1}. {chapter.title || '未命名'}
                </span>
                <div className="relative h-2 overflow-hidden rounded-full bg-white/[0.06]" title={`关键帧 ${k}/${own.length}，视频 ${v}/${own.length}`}>
                  <div className="absolute inset-y-0 left-0 bg-accent/35" style={{ width: `${(k / n) * 100}%` }} />
                  <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${(v / n) * 100}%` }} />
                </div>
                <span className="text-right font-mono text-fg-3">
                  {v}/{own.length}
                </span>
              </div>
            );
          })}
          <p className="text-[11px] text-fg-3">浅色是关键帧进度，深色是视频进度</p>
        </div>
      )}

      {issues.length > 0 && (
        <div>
          <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-fg-2">
            <AlertTriangle className="size-3.5 text-warn" /> 需要处理（{issues.length}）
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {issues.slice(0, 50).map((issue) => (
              <li key={issue.key}>
                <button onClick={() => go('shots', issue.sceneId)} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-white/[0.04]">
                  <span className={cx('size-1.5 shrink-0 rounded-full', issue.tone === 'danger' ? 'bg-danger' : 'bg-warn')} />
                  <span className="shrink-0 font-mono text-fg-2">{issue.label}</span>
                  <span className="truncate text-fg-3">{issue.message}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
