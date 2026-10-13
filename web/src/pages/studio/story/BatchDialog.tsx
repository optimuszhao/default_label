// 批量生成：选内容和模式，先让服务端试算（任务数、跳过多少、GPU 时长、预计完成时间），确认后提交
import { useEffect, useState } from 'react';
import { Clapperboard, Moon } from 'lucide-react';
import { Button, Modal, Segmented, Spinner, Toggle } from '../../../components/ui.tsx';
import { api, request } from '../../../lib/api.ts';
import { reportError, useStore } from '../../../lib/store.ts';
import { useChains } from './chains.ts';
import { useBatchDialog, useStory, type BatchScope } from './context.tsx';

type Content = 'keyframe' | 'video' | 'keyframe_then_video';
type Mode = 'missing' | 'append' | 'redo';

interface Plan {
  items: { shotId: string; purpose: string }[];
  followUps: number;
  chained: { shotId: string; afterShotId: string }[];
  chainLongest: number;
  relayNoFfmpeg: number;
  skipped: { locked: number; noDescription: number; active: number; hasResult: number };
  tasks: number;
  gpuSeconds: number;
  etaSeconds: number;
  startsAt: number | null;
}

export function formatSeconds(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} 秒`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} 分钟`;
  const hours = seconds / 3600;
  return hours < 48 ? `${hours.toFixed(1)} 小时` : `${(hours / 24).toFixed(1)} 天`;
}

function scopeLabel(scope: BatchScope): string {
  if (scope.type === 'all') return '全片';
  if (scope.type === 'shots') return `选中的 ${scope.ids.length} 个镜头`;
  return `${scope.type === 'chapter' ? '本章' : '本场'}${scope.label ? `「${scope.label}」` : ''}`;
}

export function BatchDialog() {
  const { storyId, flushNow } = useStory();
  const scope = useBatchDialog((s) => s.scope);
  const initial = useBatchDialog((s) => s.content);
  const close = useBatchDialog((s) => s.close);
  const upsertTasks = useStore((s) => s.upsertTasks);
  const toast = useStore((s) => s.toast);
  const [content, setContent] = useState<Content>(initial);
  const [mode, setMode] = useState<Mode>('missing');
  const [idle, setIdle] = useState(false);
  const [storyboard, setStoryboard] = useState(false);
  const [storyboardShots, setStoryboardShots] = useState(0);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (scope) {
      setContent(initial);
      setMode('missing');
      setIdle(false);
      setStoryboard(false);
    }
  }, [scope, initial]);

  useEffect(() => {
    if (!scope) return;
    let alive = true;
    setPlan(null);
    void (async () => {
      try {
        await flushNow?.();
        const result = await request<{ plan: Plan; storyboardShots: number }>('POST', `/api/stories/${storyId}/generate`, { scope, content, mode, idle, storyboard: storyboard && content !== 'keyframe', dryRun: true });
        if (alive) {
          setPlan(result.plan);
          setStoryboardShots(result.storyboardShots ?? 0);
        }
      } catch (error) {
        if (alive) reportError(error);
      }
    })();
    return () => {
      alive = false;
    };
  }, [scope, content, mode, idle, storyboard, storyId, flushNow]);

  async function submit() {
    if (!scope) return;
    setBusy(true);
    try {
      await flushNow?.();
      const result = await request<{ created: number; plan: Plan; storyboardShots?: number; job?: { id: string } }>('POST', `/api/stories/${storyId}/generate`, {
        scope,
        content,
        mode,
        idle,
        storyboard: storyboard && content !== 'keyframe',
      });
      if (result.job) {
        toast(`正在用 AI 给 ${result.storyboardShots} 个镜头写视频分镜，写完自动开始生成`, 'success');
        close();
        return;
      }
      upsertTasks(await api.tasks({ storyId, limit: 1000 }));
      const later = result.plan.followUps ? `，另有 ${result.plan.followUps} 个视频会在关键帧完成后自动加入` : '';
      const chained = result.plan.chained.length ? `，${result.plan.chained.length} 个镜头会接续上一镜依次生成` : '';
      toast(`已加入 ${result.created} 个任务${later}${chained}`, 'success');
      void useChains.getState().refresh(storyId);
      close();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  const skipped = plan ? plan.skipped.locked + plan.skipped.noDescription + plan.skipped.active + plan.skipped.hasResult : 0;

  return (
    <Modal open={Boolean(scope)} onClose={close} title={scope ? `批量生成 · ${scopeLabel(scope)}` : ''}>
      <div className="space-y-4">
        <div>
          <p className="label">生成什么</p>
          <Segmented
            value={content}
            onChange={setContent}
            options={[
              { value: 'keyframe', label: '关键帧' },
              { value: 'video', label: '视频' },
              { value: 'keyframe_then_video', label: '先关键帧再视频' },
            ]}
          />
        </div>
        <div>
          <p className="label">哪些镜头</p>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'missing', label: '只补缺的' },
              { value: 'append', label: '都再出一版' },
              { value: 'redo', label: '重做未定稿的' },
            ]}
          />
          <p className="mt-1.5 text-xs text-fg-3">已定稿的镜头不会被改动；有进行中任务的镜头会跳过。新候选不会替换你已经选定的画面。</p>
        </div>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5 text-sm">
          <span className="flex items-center gap-2">
            <Moon className="size-4 text-fg-3" /> 闲时生成
            <span className="text-xs text-fg-3">（夜里空闲时才开始，不占白天的算力）</span>
          </span>
          <Toggle checked={idle} onChange={setIdle} label="闲时生成" />
        </label>
        {content !== 'keyframe' && (
          <label className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5 text-sm">
            <span className="flex items-center gap-2">
              <Clapperboard className="size-4 text-fg-3" /> 先用 AI 写视频分镜
              <span className="text-xs text-fg-3">（按时间段写镜头、运镜、光线；已写过的不重写）</span>
            </span>
            <Toggle checked={storyboard} onChange={setStoryboard} label="先用 AI 写视频分镜" />
          </label>
        )}

        <div className="rounded-lg bg-white/[0.04] p-3 text-[13px]">
          {!plan ? (
            <div className="flex justify-center py-2">
              <Spinner />
            </div>
          ) : (
            <div className="space-y-1">
              <p>
                将创建 <b className="text-fg">{plan.items.length}</b> 个任务
                {plan.followUps > 0 && <>，关键帧完成后再自动加入 <b className="text-fg">{plan.followUps}</b> 个视频</>}
                {plan.chained.length > 0 && <>，另有 <b className="text-fg">{plan.chained.length}</b> 个镜头接续上一镜尾帧</>}
              </p>
              {plan.chained.length > 0 && (
                <p className="text-fg-3">
                  接续的镜头要等上一镜视频完成、截好尾帧才开始，只能一段接一段地生成（最长一串 {plan.chainLongest} 段），总耗时会比并行长。
                </p>
              )}
              {storyboard && content !== 'keyframe' && (
                <p className="text-fg-3">
                  {storyboardShots > 0 ? `先给 ${storyboardShots} 个镜头写视频分镜（每个约 5–10 秒），写完自动开始生成。` : '这些镜头都已经有视频分镜了，直接开始生成。'}
                </p>
              )}
              {plan.relayNoFfmpeg > 0 && <p className="text-warn">服务器没有 ffmpeg，截不了尾帧：{plan.relayNoFfmpeg} 个设了接续的镜头会改用自己的关键帧。</p>}
              <p className="text-fg-3">
                预计 GPU 时长 {formatSeconds(plan.gpuSeconds)}，全部完成约需 {formatSeconds(plan.etaSeconds)}
                {plan.startsAt ? `（${new Date(plan.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 开始）` : ''}
              </p>
              {skipped > 0 && (
                <p className="text-fg-3">
                  跳过：
                  {[
                    plan.skipped.hasResult && `已有结果 ${plan.skipped.hasResult}`,
                    plan.skipped.locked && `已定稿 ${plan.skipped.locked}`,
                    plan.skipped.active && `进行中 ${plan.skipped.active}`,
                    plan.skipped.noDescription && `没写画面描述 ${plan.skipped.noDescription}`,
                  ]
                    .filter(Boolean)
                    .join('，')}
                </p>
              )}
            </div>
          )}
        </div>
        <p className="text-xs text-fg-3">提交前会自动存一份历史版本。</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button variant="brand" loading={busy} disabled={!plan || plan.items.length === 0} onClick={() => void submit()}>
            开始生成
          </Button>
        </div>
      </div>
    </Modal>
  );
}
