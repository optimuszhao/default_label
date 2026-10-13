// 故事编辑器顶部的创作步骤条：每一步是一个带图标的圆形节点，按创作顺序用进度线串起来，
// 节点下面的小字是这一步的进展（几章几场、几镜、视频几条）；最底下一条细线是整体完成度。
import { useEffect, useRef } from 'react';
import { Clapperboard, Film, House, LayoutTemplate, Lightbulb, ListTree, ScrollText, Users, type LucideIcon } from 'lucide-react';
import type { StoryData } from '../../../../../shared/types.ts';
import { cx } from '../../../lib/util.ts';
import { stepDone, stepProgress, type StepId, type StepInfo, type StoryStats } from './steps.ts';

const ICON: Record<StepInfo['id'], LucideIcon> = {
  setup: Lightbulb,
  characters: Users,
  structure: ListTree,
  script: ScrollText,
  shots: Clapperboard,
  preview: Film,
  layout: LayoutTemplate,
};

export function StepRail({ steps, tab, go, data, stats }: { steps: StepInfo[]; tab: StepId; go: (id: StepId) => void; data: StoryData; stats: StoryStats }) {
  const railRef = useRef<HTMLElement>(null);
  const done = steps.map((step) => stepDone(step.id, data, stats));
  const doneCount = done.filter(Boolean).length;

  // 窄屏横向滚动时，把当前步骤滚到可见处
  useEffect(() => {
    railRef.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [tab]);

  return (
    <div className="relative">
      <nav ref={railRef} className="no-scrollbar flex items-center overflow-x-auto py-2.5" aria-label="创作步骤">
        <button
          onClick={() => go('overview')}
          aria-current={tab === 'overview' ? 'page' : undefined}
          className={cx(
            'mr-2 flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] transition-colors',
            tab === 'overview' ? 'bg-white/[0.1] text-fg' : 'text-fg-3 hover:bg-white/[0.05] hover:text-fg-2',
          )}
        >
          <House className="size-4" />
          <span className="max-sm:hidden">总览</span>
        </button>

        {steps.map((step, index) => {
          const Icon = ICON[step.id];
          const active = tab === step.id;
          const isDone = done[index];
          // 进度线：前一步完成了，这一段就点亮
          const linkLit = index > 0 && done[index - 1];
          return (
            <div key={step.id} className="flex shrink-0 items-center">
              {index > 0 && (
                <span className="relative mx-1 h-0.5 w-4 overflow-hidden rounded-full bg-white/[0.08] sm:w-8" aria-hidden>
                  <span className={cx('absolute inset-y-0 left-0 rounded-full bg-accent transition-all duration-500', linkLit ? 'w-full' : 'w-0')} />
                </span>
              )}
              <button
                onClick={() => go(step.id)}
                aria-current={active ? 'step' : undefined}
                aria-label={`第 ${index + 1} 步：${step.label}${isDone ? '（已完成）' : ''}`}
                className={cx(
                  'group flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-left transition-colors',
                  active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]',
                )}
              >
                <span
                  className={cx(
                    'relative flex size-8 shrink-0 items-center justify-center rounded-full transition-all',
                    active
                      ? 'bg-accent text-white shadow-[0_0_0_4px_rgb(77_141_255/0.18),0_0_18px_rgb(77_141_255/0.45)]'
                      : isDone
                        ? 'bg-accent/15 text-accent ring-1 ring-accent/40'
                        : 'bg-white/[0.04] text-fg-3 ring-1 ring-line-strong group-hover:text-fg-2',
                  )}
                >
                  <Icon className="size-4" />
                  <span
                    className={cx(
                      'absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full font-mono text-[9px] leading-none ring-2 ring-ink',
                      active || isDone ? 'bg-accent text-white' : 'bg-ink-3 text-fg-3',
                    )}
                  >
                    {index + 1}
                  </span>
                </span>
                <span className="flex flex-col leading-tight">
                  <span className={cx('text-[13px]', active ? 'font-semibold text-fg' : isDone ? 'text-fg-2' : 'text-fg-3 group-hover:text-fg-2')}>{step.label}</span>
                  <span className={cx('text-[10px] max-sm:hidden', active ? 'text-accent' : 'text-fg-3')}>{stepProgress(step.id, data, stats)}</span>
                </span>
              </button>
            </div>
          );
        })}
      </nav>
      {/* 整体完成度 */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-transparent" aria-hidden>
        <div className="h-full bg-accent transition-all duration-700" style={{ width: `${(doneCount / Math.max(1, steps.length)) * 100}%` }} />
      </div>
    </div>
  );
}
