import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUp,
  Clapperboard,
  Clock,
  Download,
  Film,
  Image as ImageIcon,
  ImagePlus,
  ListPlus,
  Maximize2,
  Play,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Square,
  Wand2,
  X,
} from 'lucide-react';
import { TASK_TYPE_LABEL, type Asset, type Task, type TaskType } from '../../../../shared/types.ts';
import { AssetPicker } from '../../components/AssetPicker.tsx';
import { fileName, Lightbox, useReuseAsset } from '../../components/Lightbox.tsx';
import { Button, Empty, IconButton, Media, ProgressBar, Segmented, StatusBadge } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import {
  ASPECT_RATIOS,
  CAMERA_MOTIONS,
  cssRatio,
  imageParams,
  videoParams,
} from '../../lib/presets.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { cx, downloadUrl, timeAgo } from '../../lib/util.ts';

type Mode = 'image' | 'video';

interface ComposerState {
  prompt: string;
  negativePrompt: string;
  refs: Asset[];
  firstFrame: Asset | null;
  lastFrame: Asset | null;
  aspectRatio: string;
  imageResolution: string;
  videoResolution: string;
  count: number;
  duration: number;
  cameraMotion: string;
  seed: string;
  steps: string;
  cfg: string;
  strength: number;
}

const INITIAL: ComposerState = {
  prompt: '',
  negativePrompt: '',
  refs: [],
  firstFrame: null,
  lastFrame: null,
  aspectRatio: '16:9',
  imageResolution: '1k',
  videoResolution: '720p',
  count: 1,
  duration: 5,
  cameraMotion: '自动',
  seed: '',
  steps: '',
  cfg: '',
  strength: 0.65,
};

const IDEAS: Record<Mode, string[]> = {
  image: ['水墨风格的山海经神兽，留白构图', '赛博朋克街头的拉面摊，雨夜霓虹', '温柔晨光里的少女肖像，胶片质感'],
  video: ['镜头缓缓推进，宇航员在月球上摘下头盔', '无人机俯冲穿过瀑布，水雾中出现彩虹', '一只橘猫跳上窗台，窗外樱花飘落'],
};

function RefSlot({ asset, label, onPick, onClear }: { asset: Asset | null; label: string; onPick: () => void; onClear: () => void }) {
  return asset ? (
    <div className="group relative size-14 shrink-0 overflow-hidden rounded-xl border border-line sm:size-16">
      <Media asset={asset} />
      <span className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-center text-[10px]">{label}</span>
      <button
        onClick={onClear}
        aria-label={`移除${label}`}
        className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-black/70 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  ) : (
    <button
      onClick={onPick}
      className="flex size-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl border border-dashed border-line-strong text-fg-3 transition hover:border-violet/60 hover:text-fg sm:size-16"
    >
      <Plus className="size-4" />
      <span className="text-[10px]">{label}</span>
    </button>
  );
}

function Popover({ open, onClose, children, className }: { open: boolean; onClose: () => void; children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const timer = setTimeout(() => document.addEventListener('pointerdown', onDown));
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className={cx('glass absolute bottom-full z-20 mb-2 rounded-xl p-4 shadow-2xl animate-fade-up', className)}>
      {children}
    </div>
  );
}

function Composer({ mode, onModeChange }: { mode: Mode; onModeChange: (mode: Mode) => void }) {
  const draft = useStore((s) => s.composerDraft);
  const setDraft = useStore((s) => s.setComposerDraft);
  const assets = useStore((s) => s.assets);
  const upsertTasks = useStore((s) => s.upsertTasks);
  const toast = useStore((s) => s.toast);
  const health = useStore((s) => s.health);
  const caps = useStore((s) => s.capabilities);
  const cap = mode === 'image' ? caps.image : caps.video;
  const [state, setState] = useState<ComposerState>(INITIAL);
  const [picker, setPicker] = useState<null | 'ref' | 'first' | 'last'>(null);
  const [panel, setPanel] = useState<null | 'ratio' | 'advanced'>(null);
  const [submitting, setSubmitting] = useState<null | 'queue' | 'run'>(null);
  const [polishing, setPolishing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const set = (patch: Partial<ComposerState>) => setState((prev) => ({ ...prev, ...patch }));

  // 从资产页 / 结果卡片跳转过来时带入的草稿
  useEffect(() => {
    if (!draft) return;
    onModeChange(draft.mode);
    const resolve = async (ids: string[]) => {
      const known = ids.map((id) => useStore.getState().assets[id]).filter(Boolean);
      if (known.length === ids.length) return known;
      const all = await api.assets({ kind: 'image', limit: 300 });
      return ids.map((id) => all.find((asset) => asset.id === id)).filter((asset): asset is Asset => Boolean(asset));
    };
    void (async () => {
      const refs = await resolve(draft.referenceAssetIds ?? []);
      const [first] = await resolve(draft.firstFrameAssetId ? [draft.firstFrameAssetId] : []);
      setState((prev) => ({
        ...prev,
        prompt: draft.prompt ?? prev.prompt,
        refs: refs.length ? refs : prev.refs,
        firstFrame: first ?? prev.firstFrame,
      }));
      textareaRef.current?.focus();
    })();
    setDraft(null);
  }, [draft, setDraft, onModeChange, assets]);

  // 输入框高度随内容自适应
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [state.prompt]);

  // 只把当前算子支持的输入算进去（切换算子后旧的多余参考图不会被提交）
  const refs = state.refs.slice(0, caps.image.maxReferences);
  const firstFrame = caps.video.firstFrame ? state.firstFrame : null;
  const lastFrame = caps.video.lastFrame ? state.lastFrame : null;
  const type: TaskType = mode === 'image' ? (refs.length ? 'i2i' : 't2i') : firstFrame ? 'i2v' : 't2v';
  const size =
    mode === 'image'
      ? imageParams(state.aspectRatio, state.imageResolution, {}, caps)
      : videoParams(state.aspectRatio, state.videoResolution, {}, caps);
  const ratios = cap.sizes.length ? cap.sizes.map((item) => item.aspectRatio) : ASPECT_RATIOS;
  const resolutionLabel = cap.sizes.length
    ? `${size.width}×${size.height}`
    : cap.resolutions.find((r) => r.value === (mode === 'image' ? state.imageResolution : state.videoResolution))?.label ?? '';
  const duration = cap.durations.includes(state.duration) ? state.duration : (cap.durations.find((d) => d >= state.duration) ?? cap.durations[0] ?? 5);
  const count = Math.min(state.count, caps.image.maxCount);

  async function submit(runNow: boolean) {
    if (!state.prompt.trim()) {
      toast('先写一句提示词吧', 'info');
      textareaRef.current?.focus();
      return;
    }
    const extra = {
      seed: state.seed ? Number(state.seed) : null,
      ...(state.steps && cap.steps ? { steps: Number(state.steps) } : {}),
      ...(state.cfg && cap.cfg ? { cfg: Number(state.cfg) } : {}),
    };
    const params =
      mode === 'image'
        ? imageParams(
            state.aspectRatio,
            state.imageResolution,
            { ...extra, count, ...(type === 'i2i' && caps.image.strength ? { strength: state.strength } : {}) },
            caps,
          )
        : videoParams(
            state.aspectRatio,
            state.videoResolution,
            { ...extra, duration, ...(state.cameraMotion !== '自动' ? { cameraMotion: state.cameraMotion } : {}) },
            caps,
          );
    setSubmitting(runNow ? 'run' : 'queue');
    try {
      const task = await api.createTask({
        type,
        prompt: state.prompt.trim(),
        negativePrompt: cap.negativePrompt ? state.negativePrompt.trim() : '',
        params,
        inputs: {
          referenceAssetIds: mode === 'image' ? refs.map((asset) => asset.id) : [],
          firstFrameAssetId: mode === 'video' ? (firstFrame?.id ?? null) : null,
          lastFrameAssetId: mode === 'video' ? (lastFrame?.id ?? null) : null,
        },
        runNow,
      });
      upsertTasks([task]);
      toast(runNow ? '已提交，正在尝试立即生成' : '已加入任务队列', 'success');
    } catch (error) {
      reportError(error);
    } finally {
      setSubmitting(null);
    }
  }

  async function polish() {
    if (!state.prompt.trim()) {
      set({ prompt: IDEAS[mode][Math.floor(Math.random() * IDEAS[mode].length)] });
      return;
    }
    setPolishing(true);
    try {
      const result = await api.assist<{ prompt: string }>('polish', { prompt: state.prompt, mode });
      set({ prompt: result.prompt });
    } catch (error) {
      reportError(error);
    } finally {
      setPolishing(false);
    }
  }

  const capabilityDown = health && !health[mode];

  return (
    <div className="rounded-xl border border-line-strong bg-ink-1/95 p-3 shadow-[0_16px_48px_-12px_rgb(0_0_0/0.85)] backdrop-blur-xl sm:p-3.5">
      <div className="flex items-start gap-2 sm:gap-3">
        {mode === 'image' ? (
          caps.image.maxReferences > 0 && (
            <div className="flex gap-1.5">
              {refs.map((asset) => (
                <RefSlot key={asset.id} asset={asset} label="参考" onPick={() => undefined} onClear={() => set({ refs: state.refs.filter((item) => item.id !== asset.id) })} />
              ))}
              {refs.length < caps.image.maxReferences && <RefSlot asset={null} label="参考图" onPick={() => setPicker('ref')} onClear={() => undefined} />}
            </div>
          )
        ) : (
          caps.video.firstFrame && (
            <div className="flex gap-1.5">
              <RefSlot asset={firstFrame} label="首帧" onPick={() => setPicker('first')} onClear={() => set({ firstFrame: null })} />
              {firstFrame && caps.video.lastFrame && (
                <RefSlot asset={lastFrame} label="尾帧" onPick={() => setPicker('last')} onClear={() => set({ lastFrame: null })} />
              )}
            </div>
          )
        )}
        <textarea
          ref={textareaRef}
          value={state.prompt}
          onChange={(e) => set({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(true);
          }}
          rows={2}
          maxLength={4000}
          placeholder={
            mode === 'image'
              ? refs.length
                ? '描述你想如何改变参考图……'
                : '描述你想生成的画面，例如：雨夜霓虹街头的赛博少女，电影感光影'
              : firstFrame
                ? '描述画面如何动起来，例如：镜头缓慢推进，人物转身微笑'
                : '描述视频画面与镜头运动，例如：无人机穿过云海，晨光洒在雪山上'
          }
          className="min-h-[3.5rem] flex-1 resize-none bg-transparent py-1 text-[15px] leading-relaxed placeholder:text-fg-3 focus:outline-none"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 sm:flex-nowrap">
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto max-sm:basis-full">
          <Segmented
            size="sm"
            value={mode}
            onChange={onModeChange}
            options={[
              { value: 'image', label: <><ImageIcon className="size-3.5" />图片</> },
              { value: 'video', label: <><Film className="size-3.5" />视频</> },
            ]}
          />
          <span className="chip !h-7 !text-xs" data-active="true">{TASK_TYPE_LABEL[type]}</span>
          <button className="chip !h-7 !text-xs" onClick={() => setPanel(panel === 'ratio' ? null : 'ratio')}>
            <span className="inline-block rounded-[3px] border border-current" style={{ aspectRatio: cssRatio(state.aspectRatio), height: 11 }} />
            {state.aspectRatio} · {resolutionLabel}
          </button>
          {mode === 'video' ? (
            <button
              className="chip !h-7 !text-xs"
              onClick={() => set({ duration: cap.durations[(cap.durations.indexOf(duration) + 1) % cap.durations.length] ?? duration })}
            >
              <Clock className="size-3.5" /> {duration}s
            </button>
          ) : (
            caps.image.maxCount > 1 && (
              <button className="chip !h-7 !text-xs" onClick={() => set({ count: (count % caps.image.maxCount) + 1 })}>
                {count} 张
              </button>
            )
          )}
          <button className="chip !h-7 !text-xs" onClick={() => setPanel(panel === 'advanced' ? null : 'advanced')} aria-label="高级参数">
            <SlidersHorizontal className="size-3.5" />
            <span className="hidden sm:inline">高级</span>
          </button>
        </div>

        <div className="relative flex shrink-0 items-center gap-1.5 max-sm:ml-auto">
          <IconButton label="AI 润色提示词" onClick={() => void polish()} disabled={polishing} className={cx(polishing && 'animate-pulse')}>
            <Wand2 className="size-4" />
          </IconButton>
          <IconButton label="加入队列" onClick={() => void submit(false)} disabled={submitting !== null}>
            <ListPlus className="size-4" />
          </IconButton>
          <button
            onClick={() => void submit(true)}
            disabled={submitting !== null}
            aria-label="立即生成"
            title="立即生成（Ctrl/⌘ + Enter）"
            className="bg-brand flex size-10 items-center justify-center rounded-full text-white shadow-lg transition hover:brightness-110 active:scale-95 disabled:opacity-50"
          >
            <ArrowUp className="size-5" />
          </button>

          <Popover open={panel === 'ratio'} onClose={() => setPanel(null)} className="right-0 w-[min(20rem,calc(100vw-2rem))]">
            <p className="label">画面比例</p>
            <div className="grid grid-cols-3 gap-2">
              {ratios.map((ratio) => (
                <button key={ratio} className="chip !h-auto flex-col !py-2" data-active={state.aspectRatio === ratio} onClick={() => set({ aspectRatio: ratio })}>
                  <span className="inline-block rounded-[3px] border-[1.5px] border-current" style={{ aspectRatio: cssRatio(ratio), height: 18 }} />
                  {ratio}
                </button>
              ))}
            </div>
            {cap.sizes.length > 0 ? (
              <p className="mt-3 text-xs text-fg-3">
                尺寸由生成服务固定为 {size.width}×{size.height}
                {cap.note ? `，${cap.note}` : ''}
              </p>
            ) : (
              <>
                <p className="label mt-4">分辨率</p>
                <div className="flex flex-wrap gap-2">
                  {cap.resolutions.map((item) => {
                    const active = mode === 'image' ? state.imageResolution === item.value : state.videoResolution === item.value;
                    return (
                      <button
                        key={item.value}
                        className="chip"
                        data-active={active}
                        onClick={() => set(mode === 'image' ? { imageResolution: item.value } : { videoResolution: item.value })}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            {mode === 'video' && cap.durations.length > 0 && (
              <>
                <p className="label mt-4">时长</p>
                <div className="flex flex-wrap gap-2">
                  {cap.durations.map((value) => (
                    <button key={value} className="chip" data-active={duration === value} onClick={() => set({ duration: value })}>
                      {value} 秒
                    </button>
                  ))}
                </div>
              </>
            )}
          </Popover>

          <Popover open={panel === 'advanced'} onClose={() => setPanel(null)} className="right-0 w-[min(22rem,calc(100vw-2rem))] space-y-3">
            {mode === 'video' && (
              <div>
                <p className="label">镜头运动</p>
                <div className="flex flex-wrap gap-1.5">
                  {CAMERA_MOTIONS.map((motion) => (
                    <button key={motion} className="chip !h-7 !text-xs" data-active={state.cameraMotion === motion} onClick={() => set({ cameraMotion: motion })}>
                      {motion}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {mode === 'image' && refs.length > 0 && caps.image.strength && (
              <div>
                <p className="label">重绘强度 {state.strength.toFixed(2)}</p>
                <input type="range" min={0.1} max={1} step={0.05} value={state.strength} onChange={(e) => set({ strength: Number(e.target.value) })} className="w-full accent-violet" />
              </div>
            )}
            {cap.negativePrompt && (
              <div>
                <p className="label">反向提示词</p>
                <textarea className="field resize-none text-sm" rows={2} value={state.negativePrompt} onChange={(e) => set({ negativePrompt: e.target.value })} placeholder="不希望出现的内容，例如：模糊、畸形、水印" />
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <div>
                <p className="label">种子</p>
                <input className="field !px-2.5 text-sm" inputMode="numeric" value={state.seed} onChange={(e) => set({ seed: e.target.value.replace(/\D/g, '') })} placeholder="随机" />
              </div>
              {cap.steps && (
                <div>
                  <p className="label">步数</p>
                  <input className="field !px-2.5 text-sm" inputMode="numeric" value={state.steps} onChange={(e) => set({ steps: e.target.value.replace(/\D/g, '') })} placeholder="默认" />
                </div>
              )}
              {cap.cfg && (
                <div>
                  <p className="label">CFG</p>
                  <input className="field !px-2.5 text-sm" inputMode="decimal" value={state.cfg} onChange={(e) => set({ cfg: e.target.value.replace(/[^\d.]/g, '') })} placeholder="默认" />
                </div>
              )}
            </div>
          </Popover>
        </div>
      </div>

      {capabilityDown && (
        <p className="mt-2 text-xs text-warn">
          {mode === 'image' ? '图像' : '视频'}生成服务暂不可用，任务会先进入队列，服务恢复后自动生成。
        </p>
      )}

      <AssetPicker
        open={picker !== null}
        onClose={() => setPicker(null)}
        max={picker === 'ref' ? Math.max(1, caps.image.maxReferences - refs.length) : 1}
        title={picker === 'ref' ? '选择参考图' : picker === 'first' ? '选择首帧' : '选择尾帧'}
        onPick={(picked) => {
          if (picker === 'ref') set({ refs: [...refs, ...picked].slice(0, caps.image.maxReferences) });
          if (picker === 'first') set({ firstFrame: picked[0] });
          if (picker === 'last') set({ lastFrame: picked[0] });
        }}
      />
    </div>
  );
}

const TaskCard = memo(function TaskCard({ task, onOpen }: { task: Task; onOpen: (asset: Asset) => void }) {
  const assets = useStore((s) => s.assets);
  const upsertTasks = useStore((s) => s.upsertTasks);
  const setDraft = useStore((s) => s.setComposerDraft);
  const reuse = useReuseAsset();
  const outputs = task.outputAssetIds.map((id) => assets[id]).filter((asset): asset is Asset => Boolean(asset));
  const isVideo = task.type === 't2v' || task.type === 'i2v';
  const pending = task.status !== 'succeeded';
  const slots = pending ? Math.max(1, task.params.count || 1) : outputs.length;
  const refs = [...(task.inputs.referenceAssetIds ?? []), task.inputs.firstFrameAssetId].filter(Boolean) as string[];

  async function act(action: 'run' | 'cancel' | 'retry') {
    try {
      upsertTasks([await api.taskAction(task.id, action)]);
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <article className="cv-auto animate-fade-up">
      <div className="mb-3 flex items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.06]">
          {isVideo ? <Film className="size-3.5" /> : <ImageIcon className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm leading-relaxed text-fg">{task.prompt}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
            <StatusBadge status={task.status} waiting={Boolean(task.waitReason)} />
            <span>{TASK_TYPE_LABEL[task.type]}</span>
            <span>·</span>
            <span>{task.params.aspectRatio}</span>
            {isVideo && <span>· {task.params.duration}s</span>}
            {refs.length > 0 && <span>· {refs.length} 张参考</span>}
            <span>· {timeAgo(task.createdAt)}</span>
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
                  {task.status === 'queued' && (
                    <p className="text-xs text-fg-2">{task.waitReason ? '等待生成服务恢复…' : '排队中…'}</p>
                  )}
                  {task.status === 'failed' && <p className="text-xs text-danger">{task.lastError ?? '生成失败'}</p>}
                  {task.status === 'paused' && <p className="text-xs text-fg-3">已暂停</p>}
                  {task.status === 'canceled' && <p className="text-xs text-fg-3">已取消</p>}
                </div>
              </div>
            ))
          : outputs.map((asset) => (
              <div
                key={asset.id}
                className="group relative overflow-hidden rounded-xl border border-line bg-ink-2"
                style={{ aspectRatio: cssRatio(task.params.aspectRatio) }}
              >
                <button className="absolute inset-0" onClick={() => onOpen(asset)} aria-label="查看大图">
                  <Media asset={asset} />
                </button>
                {isVideo && (
                  <span className="pointer-events-none absolute top-2 left-2 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] backdrop-blur">
                    <Play className="size-2.5 fill-current" /> {task.params.duration}s
                  </span>
                )}
                <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-black/55 p-2 opacity-100 transition-opacity duration-200 sm:opacity-0 sm:group-hover:opacity-100">
                  {!isVideo && (
                    <>
                      <IconButton label="图生图" className="size-8 bg-black/40" onClick={() => reuse.toImage(asset)}>
                        <ImagePlus className="size-3.5" />
                      </IconButton>
                      <IconButton label="图生视频" className="size-8 bg-black/40" onClick={() => reuse.toVideo(asset)}>
                        <Clapperboard className="size-3.5" />
                      </IconButton>
                    </>
                  )}
                  <IconButton label="下载" className="size-8 bg-black/40" onClick={() => downloadUrl(asset.url, fileName(asset))}>
                    <Download className="size-3.5" />
                  </IconButton>
                  <IconButton label="全屏查看" className="size-8 bg-black/40" onClick={() => onOpen(asset)}>
                    <Maximize2 className="size-3.5" />
                  </IconButton>
                </div>
              </div>
            ))}
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1">
        {task.status === 'queued' && (
          <Button size="sm" variant="ghost" icon={<Play className="size-3.5" />} onClick={() => void act('run')}>立即运行</Button>
        )}
        {(task.status === 'queued' || task.status === 'running' || task.status === 'paused') && (
          <Button size="sm" variant="ghost" icon={<Square className="size-3.5" />} onClick={() => void act('cancel')}>取消</Button>
        )}
        {(task.status === 'failed' || task.status === 'canceled' || task.status === 'succeeded') && (
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => void act('retry')}>
            {task.status === 'succeeded' ? '再次生成' : '重试'}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={<Sparkles className="size-3.5" />}
          onClick={() => {
            setDraft({
              mode: isVideo ? 'video' : 'image',
              prompt: task.prompt,
              referenceAssetIds: task.inputs.referenceAssetIds,
              firstFrameAssetId: task.inputs.firstFrameAssetId,
            });
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
          }}
        >
          复用提示词
        </Button>
      </div>
    </article>
  );
});

const PAGE = 20;

export default function Create() {
  const [mode, setMode] = useState<Mode>('image');
  const tasks = useStore((s) => s.tasks);
  const upsertAssets = useStore((s) => s.upsertAssets);
  const [viewing, setViewing] = useState<Asset | null>(null);
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    void api.assets({ limit: 300 }).then(upsertAssets).catch(() => undefined);
  }, [upsertAssets]);

  const list = useMemo(
    () =>
      Object.values(tasks)
        .filter((task) => !task.link.storyId)
        .filter((task) => (mode === 'image' ? task.type === 't2i' || task.type === 'i2i' : task.type === 't2v' || task.type === 'i2v'))
        .sort((a, b) => b.createdAt - a.createdAt),
    [tasks, mode],
  );

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-56px-76px)] max-w-5xl flex-col px-4 pt-6 sm:px-6 md:min-h-dvh md:pt-10">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {mode === 'image' ? '图片生成' : '视频生成'}
          </h1>
          <p className="mt-1 text-sm text-fg-3">
            {mode === 'image' ? '文生图 · 添加参考图即为图生图' : '文生视频 · 添加首帧即为图生视频'}
          </p>
        </div>
        <Link to="/studio/stories" className="hidden text-sm text-fg-2 hover:text-fg sm:block">
          要做长篇故事？去故事工坊 →
        </Link>
      </div>

      <div className="flex-1 space-y-10 pb-8">
        {list.length === 0 ? (
          <Empty
            icon={mode === 'image' ? <ImageIcon className="size-6" /> : <Film className="size-6" />}
            title="开始你的第一次创作"
            hint="在下方输入提示词，点击发送立即生成，或加入队列稍后批量生成。"
          />
        ) : (
          list.slice(0, limit).map((task) => <TaskCard key={task.id} task={task} onOpen={setViewing} />)
        )}
        {list.length > limit && (
          <div className="text-center">
            <Button variant="ghost" onClick={() => setLimit((value) => value + PAGE)}>加载更多</Button>
          </div>
        )}
      </div>

      <div className="sticky bottom-[calc(76px+env(safe-area-inset-bottom))] z-20 -mx-1 pb-3 md:bottom-0 md:pb-6">
        <Composer mode={mode} onModeChange={setMode} />
      </div>

      <Lightbox asset={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
