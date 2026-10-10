// 创作台 2.0 的输入区（Composer）
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp,
  ChevronUp,
  Clock,
  Dice5,
  Eye,
  Film,
  Image as ImageIcon,
  Languages,
  Lightbulb,
  ListPlus,
  Lock,
  Plus,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import { applyMoveToNegative } from '../../../../../shared/lint.ts';
import { ASPECT_RATIOS } from '../../../../../shared/operator.ts';
import { TASK_TYPE_LABEL, type Asset } from '../../../../../shared/types.ts';
import { AssetPicker, useUpload } from '../../../components/AssetPicker.tsx';
import { Button, IconButton, Media, Modal, Segmented } from '../../../components/ui.tsx';
import { api } from '../../../lib/api.ts';
import { cssRatio } from '../../../lib/presets.ts';
import { reportError, useStore } from '../../../lib/store.ts';
import { cx } from '../../../lib/util.ts';
import { useCatalog } from './catalog.ts';
import { PresetPanel, SelectedPresets, type PanelTab } from './PresetPanel.tsx';
import type { Composer as ComposerModel } from './useComposer.ts';

export function Popover({ open, onClose, children, className }: { open: boolean; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    const timer = setTimeout(() => document.addEventListener('pointerdown', onDown));
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className={cx('glass absolute bottom-full z-30 mb-2 max-h-[70dvh] overflow-auto rounded-xl p-4 shadow-2xl animate-fade-up', className)}>
      {children}
    </div>
  );
}

function RefSlot({ asset, label, onPick, onClear }: { asset: Asset | null; label: string; onPick: () => void; onClear: () => void }) {
  return asset ? (
    <div className="group relative size-14 shrink-0 overflow-hidden rounded-lg border border-line sm:size-16">
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
      className="flex size-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-line-strong text-fg-3 transition hover:border-accent/60 hover:text-fg sm:size-16"
    >
      <Plus className="size-4" />
      <span className="text-[10px]">{label}</span>
    </button>
  );
}

type AiKind = 'expand' | 'polish' | 'translate-en' | 'translate-zh' | 'variants' | 'inspire';

const AI_ITEMS: { kind: AiKind; label: string; icon: ReactNode; needsText: boolean }[] = [
  { kind: 'expand', label: '扩写成完整描述', icon: <Wand2 className="size-4" />, needsText: true },
  { kind: 'polish', label: '润色', icon: <Sparkles className="size-4" />, needsText: true },
  { kind: 'variants', label: '写 4 个变体', icon: <Shuffle className="size-4" />, needsText: true },
  { kind: 'translate-en', label: '翻译成英文', icon: <Languages className="size-4" />, needsText: true },
  { kind: 'translate-zh', label: '翻译成中文', icon: <Languages className="size-4" />, needsText: true },
  { kind: 'inspire', label: '随机灵感', icon: <Lightbulb className="size-4" />, needsText: false },
];

/** AI 结果：多个候选让用户挑 */
function AiResults({ open, title, items, onPick, onClose }: { open: boolean; title: string; items: { label?: string; text: string }[]; onPick: (text: string) => void; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li key={index}>
            <button className="w-full rounded-lg border border-line bg-white/[0.03] p-3 text-left text-sm leading-relaxed hover:border-accent/60" onClick={() => onPick(item.text)}>
              {item.label && <span className="mb-1 block text-xs text-accent">{item.label}</span>}
              {item.text}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function ComposerPanel({
  composer,
  onSubmitted,
  compact,
}: {
  composer: ComposerModel;
  onSubmitted?: () => void;
  /** 手机收起状态：只显示一行输入和生成按钮 */
  compact?: { onExpand: () => void };
}) {
  const caps = useStore((s) => s.capabilities);
  const health = useStore((s) => s.health);
  const toast = useStore((s) => s.toast);
  const upsertTasks = useStore((s) => s.upsertTasks);
  const templates = useCatalog((s) => s.templates);
  const presetMap = useCatalog((s) => s.presetMap);
  const { upload, uploading } = useUpload();
  const { mode, state, type, compiled, hints } = composer;
  const recipe = state.recipe;
  const cap = mode === 'image' ? caps.image : caps.video;
  const template = templates.find((t) => t.id === recipe.templateId) ?? null;
  const [panel, setPanel] = useState<null | 'size' | 'advanced' | 'ai' | 'preview'>(null);
  const [presetTab, setPresetTab] = useState<PanelTab | null>(null);
  const [picker, setPicker] = useState<null | 'ref' | 'first' | 'last'>(null);
  const [submitting, setSubmitting] = useState<null | 'queue' | 'run'>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<{ title: string; items: { label?: string; text: string }[] } | null>(null);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const seedLocked = recipe.overrides.seed != null;

  // 输入框高度随内容自适应
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, compact ? 72 : 200)}px`;
  }, [recipe.text, compact]);

  async function submit(runNow: boolean) {
    if (!compiled.prompt) {
      toast(template ? '模板还缺内容，填一下变量吧' : '先写一句提示词吧', 'info');
      textareaRef.current?.focus();
      return;
    }
    if (template?.requiresReference && !(mode === 'image' ? state.refs.length : state.firstFrame)) {
      toast(`「${template.name}」需要先选一张${mode === 'image' ? '参考图' : '首帧图片'}`, 'info');
      setPicker(mode === 'image' ? 'ref' : 'first');
      return;
    }
    setSubmitting(runNow ? 'run' : 'queue');
    try {
      const task = await api.createTask({
        type,
        prompt: '',
        params: compiled.params,
        inputs: {
          referenceAssetIds: mode === 'image' ? state.refs.map((a) => a.id) : [],
          firstFrameAssetId: mode === 'video' ? (state.firstFrame?.id ?? null) : null,
          lastFrameAssetId: mode === 'video' && caps.video.lastFrame ? (state.lastFrame?.id ?? null) : null,
        },
        recipe: { ...recipe, mode },
        runNow,
      });
      upsertTasks([task]);
      toast(runNow ? '已提交，正在尝试立即生成' : '已加入任务队列', 'success');
      onSubmitted?.();
    } catch (error) {
      reportError(error);
    } finally {
      setSubmitting(null);
    }
  }

  async function runAi(kind: AiKind) {
    setPanel(null);
    const text = recipe.text.trim() || (template ? compiled.prompt : '');
    if (AI_ITEMS.find((item) => item.kind === kind)?.needsText && !text) {
      toast('先写一句提示词，AI 才能帮你改', 'info');
      return;
    }
    setAiBusy(true);
    try {
      if (kind === 'expand' || kind === 'polish') {
        const result = await api.assist<{ prompt: string }>(kind, { prompt: text, mode });
        composer.setRecipe({ text: result.prompt, ...(template && !recipe.text.trim() ? { templateId: null, presets: compiled.presets } : {}) });
      } else if (kind === 'translate-en' || kind === 'translate-zh') {
        const result = await api.assist<{ prompt: string }>('translate', { prompt: recipe.text.trim() || text, to: kind === 'translate-en' ? 'en' : 'zh' });
        setAiResult({ title: '翻译结果', items: [{ text: result.prompt }] });
      } else if (kind === 'variants') {
        const result = await api.assist<{ variants: { change: string; prompt: string }[] }>('variants', { prompt: text, mode });
        setAiResult({ title: '选一个变体', items: result.variants.map((v) => ({ label: v.change, text: v.prompt })) });
      } else {
        const result = await api.assist<{ ideas: string[]; offline?: boolean }>('inspire', { mode });
        setAiResult({ title: result.offline ? '随机灵感（离线词库）' : '随机灵感', items: result.ideas.map((text) => ({ text })) });
      }
    } catch (error) {
      reportError(error);
    } finally {
      setAiBusy(false);
    }
  }

  async function onDrop(files: FileList) {
    const images = Array.from(files).filter((file) => file.type.startsWith('image/'));
    if (!images.length) return;
    const uploaded = await upload(images.slice(0, 1));
    if (!uploaded[0]) return;
    if (mode === 'image') {
      composer.set({ refs: [...state.refs, uploaded[0]].slice(0, Math.max(1, caps.image.maxReferences)) });
      toast('已作为参考图，切换为图生图', 'info');
    } else {
      composer.set({ firstFrame: uploaded[0] });
      toast('已作为首帧，切换为图生视频', 'info');
    }
  }

  const ratios = cap.sizes.length ? cap.sizes.map((s) => s.aspectRatio) : ASPECT_RATIOS;
  const aspect = compiled.params.aspectRatio;
  const upscaled = mode === 'video' && cap.note?.includes('2x') ? `→ 超分后 ${compiled.params.width * 2}×${compiled.params.height * 2}` : '';
  const down = health && !health[mode];
  const visibleHints = [...hints.filter((h) => h.level === 'warn'), ...hints.filter((h) => h.level === 'info')].slice(0, 2);

  if (compact) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line-strong bg-ink-1/95 p-2 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.85)] backdrop-blur-xl">
        <button onClick={compact.onExpand} className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.06]" aria-label="展开创作面板">
          {mode === 'image' ? <ImageIcon className="size-4" /> : <Film className="size-4" />}
        </button>
        <button onClick={compact.onExpand} className="min-w-0 flex-1 truncate text-left text-sm text-fg-3">
          {template ? `${template.name} · ` : ''}
          {recipe.text || (template ? '补充描述（可选）' : mode === 'image' ? '描述你想生成的画面…' : '描述视频画面与动作…')}
        </button>
        <button
          onClick={() => void submit(true)}
          disabled={submitting !== null}
          aria-label="立即生成"
          className="bg-brand flex size-9 shrink-0 items-center justify-center rounded-full text-white disabled:opacity-50"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cx(
        'rounded-xl border bg-ink-1/95 p-3 shadow-[0_16px_48px_-12px_rgb(0_0_0/0.85)] backdrop-blur-xl transition-colors sm:p-3.5',
        dragging ? 'border-accent' : 'border-line-strong',
      )}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.items).some((item) => item.kind === 'file')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void onDrop(e.dataTransfer.files);
      }}
    >
      {/* 模式与模板 */}
      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        <Segmented
          size="sm"
          label="创作模式"
          value={mode}
          onChange={composer.setMode}
          options={[
            { value: 'image', label: <><ImageIcon className="size-3.5" />图片</> },
            { value: 'video', label: <><Film className="size-3.5" />视频</> },
          ]}
        />
        <span className="chip !h-7 !text-xs" data-active="true">{TASK_TYPE_LABEL[type]}</span>
        {template ? (
          <span className="inline-flex h-7 items-center gap-1 rounded-md border border-accent/50 bg-accent/10 pr-1 pl-2 text-xs">
            <button onClick={() => setPresetTab('template')}>模板：{template.name}</button>
            <button aria-label="不用模板" className="flex size-5 items-center justify-center rounded hover:bg-white/10" onClick={() => composer.setRecipe({ templateId: null, vars: {} })}>
              <X className="size-3" />
            </button>
          </span>
        ) : (
          <button className="chip !h-7 !text-xs" onClick={() => setPresetTab('template')}>
            <Sparkles className="size-3.5" /> 套用模板
          </button>
        )}
        {uploading && <span className="text-xs text-fg-3">上传中…</span>}
      </div>

      {/* 模板变量 */}
      {template && template.variables.length > 0 && (
        <div className="mb-2.5 grid gap-2 sm:grid-cols-2">
          {template.variables.map((variable) => (
            <label key={variable.key} className="flex items-center gap-2 rounded-lg border border-line bg-white/[0.03] px-2.5 py-1.5">
              <span className="shrink-0 text-xs text-fg-3">{variable.label}</span>
              <input
                className="min-w-0 flex-1 bg-transparent text-sm focus:outline-none"
                value={recipe.vars?.[variable.key] ?? ''}
                placeholder={variable.default ?? variable.placeholder ?? ''}
                onChange={(e) => composer.setRecipe({ vars: { ...recipe.vars, [variable.key]: e.target.value } })}
              />
              {variable.options && (
                <span className="no-scrollbar flex max-w-[50%] gap-1 overflow-x-auto">
                  {variable.options.map((option) => (
                    <button
                      key={option}
                      className="chip !h-6 shrink-0 !px-1.5 !text-[11px]"
                      data-active={(recipe.vars?.[variable.key] || variable.default) === option}
                      onClick={() => composer.setRecipe({ vars: { ...recipe.vars, [variable.key]: option } })}
                    >
                      {option}
                    </button>
                  ))}
                </span>
              )}
            </label>
          ))}
        </div>
      )}

      {/* 参考图 + 正文 */}
      <div className="flex items-start gap-2 sm:gap-3">
        {mode === 'image'
          ? caps.image.maxReferences > 0 && (
              <div className="flex gap-1.5">
                {state.refs.map((asset) => (
                  <RefSlot key={asset.id} asset={asset} label="参考" onPick={() => undefined} onClear={() => composer.set({ refs: state.refs.filter((a) => a.id !== asset.id) })} />
                ))}
                {state.refs.length < caps.image.maxReferences && <RefSlot asset={null} label="参考图" onPick={() => setPicker('ref')} onClear={() => undefined} />}
              </div>
            )
          : caps.video.firstFrame && (
              <div className="flex gap-1.5">
                <RefSlot asset={state.firstFrame} label="首帧" onPick={() => setPicker('first')} onClear={() => composer.set({ firstFrame: null })} />
                {state.firstFrame && caps.video.lastFrame && (
                  <RefSlot asset={state.lastFrame} label="尾帧" onPick={() => setPicker('last')} onClear={() => composer.set({ lastFrame: null })} />
                )}
              </div>
            )}
        <textarea
          ref={textareaRef}
          value={recipe.text}
          onChange={(e) => composer.setRecipe({ text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit(true);
            }
          }}
          rows={2}
          maxLength={4000}
          aria-label="提示词"
          placeholder={
            template
              ? '补充描述（可选），会接在模板后面'
              : mode === 'image'
                ? state.refs.length
                  ? '描述你想如何改变参考图……'
                  : '描述你想生成的画面，例如：雨夜霓虹街头的赛博少女，电影感光影'
                : state.firstFrame
                  ? '描述画面如何动起来，例如：镜头缓慢推进，人物转身微笑'
                  : '描述视频画面与动作，例如：无人机穿过云海，晨光洒在雪山上'
          }
          className="min-h-[3.25rem] flex-1 resize-none bg-transparent py-1 text-[15px] leading-relaxed placeholder:text-fg-3 focus:outline-none"
        />
      </div>

      <div className="mt-2">
        <SelectedPresets composer={composer} onOpen={setPresetTab} />
      </div>

      {/* 工具栏 */}
      <div className="mt-2.5 flex flex-wrap items-center gap-2 sm:flex-nowrap">
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto max-sm:basis-full">
          <button className="chip !h-7 !text-xs" onClick={() => setPresetTab('style')}>
            <Sparkles className="size-3.5" /> 预设{compiled.presets.length ? ` ${compiled.presets.length}` : ''}
          </button>
          <button className="chip !h-7 !text-xs" onClick={() => setPanel(panel === 'size' ? null : 'size')}>
            <span className="inline-block rounded-[3px] border border-current" style={{ aspectRatio: cssRatio(aspect), height: 11 }} />
            {aspect} · {compiled.params.width}×{compiled.params.height}
          </button>
          {mode === 'video' ? (
            <button
              className="chip !h-7 !text-xs"
              onClick={() => composer.setOverrides({ duration: cap.durations[(cap.durations.indexOf(compiled.params.duration ?? 5) + 1) % cap.durations.length] })}
            >
              <Clock className="size-3.5" /> {compiled.params.duration}s
            </button>
          ) : (
            caps.image.maxCount > 1 && (
              <button className="chip !h-7 !text-xs" onClick={() => composer.setOverrides({ count: (compiled.params.count % caps.image.maxCount) + 1 })}>
                {compiled.params.count} 张
              </button>
            )
          )}
          <button
            className="chip !h-7 !text-xs"
            data-active={seedLocked}
            title={seedLocked ? '种子已锁定：每次生成用同一个种子，方便微调' : '每次随机种子'}
            onClick={() => composer.setOverrides({ seed: seedLocked ? null : Math.floor(Math.random() * 2 ** 31) })}
          >
            {seedLocked ? <Lock className="size-3.5" /> : <Dice5 className="size-3.5" />}
            {seedLocked ? recipe.overrides.seed : '随机'}
          </button>
          <button className="chip !h-7 !text-xs" onClick={() => setPanel(panel === 'advanced' ? null : 'advanced')} aria-label="高级参数">
            <SlidersHorizontal className="size-3.5" />
            <span className="hidden sm:inline">高级</span>
          </button>
        </div>

        <div className="relative flex shrink-0 items-center gap-1.5 max-sm:ml-auto">
          <IconButton label="AI 助手" onClick={() => setPanel(panel === 'ai' ? null : 'ai')} disabled={aiBusy} className={cx(aiBusy && 'animate-pulse')}>
            <Wand2 className="size-4" />
          </IconButton>
          <IconButton label="预览最终提示词" onClick={() => setPanel(panel === 'preview' ? null : 'preview')}>
            <Eye className="size-4" />
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

          <Popover open={panel === 'size'} onClose={() => setPanel(null)} className="right-0 w-[min(21rem,calc(100vw-2rem))]">
            <p className="label">画面比例</p>
            <div className="grid grid-cols-3 gap-2">
              {ratios.map((ratio) => (
                <button key={ratio} className="chip !h-auto flex-col !py-2" data-active={aspect === ratio} onClick={() => composer.setOverrides({ aspectRatio: ratio })}>
                  <span className="inline-block rounded-[3px] border-[1.5px] border-current" style={{ aspectRatio: cssRatio(ratio), height: 18 }} />
                  {ratio}
                </button>
              ))}
            </div>
            {cap.sizes.length === 0 && cap.resolutions.length > 0 && (
              <>
                <p className="label mt-4">清晰度</p>
                <div className="flex flex-wrap gap-2">
                  {cap.resolutions.map((item) => (
                    <button key={item.value} className="chip" data-active={compiled.params.resolution === item.value} onClick={() => composer.setOverrides({ resolution: item.value })}>
                      {item.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            <p className="mt-3 text-xs text-fg-3">
              实际提交 {compiled.params.width}×{compiled.params.height} {upscaled}
              {cap.sizes.length > 0 && '（尺寸由算子固定）'}
            </p>
            {mode === 'video' && cap.durations.length > 0 && (
              <>
                <p className="label mt-4">时长</p>
                <div className="flex flex-wrap gap-2">
                  {cap.durations.map((value) => (
                    <button key={value} className="chip" data-active={compiled.params.duration === value} onClick={() => composer.setOverrides({ duration: value })}>
                      {value} 秒
                    </button>
                  ))}
                </div>
              </>
            )}
            {mode === 'image' && caps.image.maxCount > 1 && (
              <>
                <p className="label mt-4">张数</p>
                <div className="flex gap-2">
                  {Array.from({ length: caps.image.maxCount }, (_, i) => i + 1).map((n) => (
                    <button key={n} className="chip" data-active={compiled.params.count === n} onClick={() => composer.setOverrides({ count: n })}>
                      {n}
                    </button>
                  ))}
                </div>
              </>
            )}
          </Popover>

          <Popover open={panel === 'advanced'} onClose={() => setPanel(null)} className="right-0 w-[min(22rem,calc(100vw-2rem))] space-y-3">
            <div>
              <p className="label">种子</p>
              <div className="flex gap-2">
                <input
                  className="field !px-2.5 text-sm"
                  inputMode="numeric"
                  value={recipe.overrides.seed ?? ''}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, '');
                    composer.setOverrides({ seed: digits ? Number(digits) : null });
                  }}
                  placeholder="随机"
                />
                <Button size="sm" variant="ghost" onClick={() => composer.setOverrides({ seed: null })}>
                  随机
                </Button>
              </div>
            </div>
            {cap.steps && (
              <div>
                <p className="label">步数（留空用默认）</p>
                <input
                  className="field !px-2.5 text-sm"
                  inputMode="numeric"
                  value={recipe.overrides.steps ?? ''}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, '');
                    composer.setOverrides({ steps: digits ? Math.min(150, Number(digits)) : undefined });
                  }}
                  placeholder="默认"
                />
              </div>
            )}
            {cap.negativePrompt ? (
              <div>
                <p className="label">反向提示词</p>
                <textarea
                  className="field resize-none text-sm"
                  rows={2}
                  value={recipe.negative}
                  onChange={(e) => composer.setRecipe({ negative: e.target.value })}
                  placeholder="不希望出现的内容，例如：模糊、畸形、水印（也可以在预设的“负向”里选）"
                />
              </div>
            ) : (
              <p className="text-xs text-fg-3">当前算子的{mode === 'video' ? '视频' : '图片'}不支持反向提示词；“负向”预设会自动改写成正向约束。</p>
            )}
          </Popover>

          <Popover open={panel === 'ai'} onClose={() => setPanel(null)} className="right-0 w-56 !p-1.5">
            {AI_ITEMS.map((item) => (
              <button
                key={item.kind}
                onClick={() => void runAi(item.kind)}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-fg-2 hover:bg-white/[0.06] hover:text-fg"
              >
                {item.icon}
                {item.label}
              </button>
            ))}
            {health && !health.llm && <p className="px-3 py-2 text-xs text-fg-3">语言模型未配置：只有“随机灵感”可用（离线词库）</p>}
          </Popover>

          <Popover open={panel === 'preview'} onClose={() => setPanel(null)} className="right-0 w-[min(28rem,calc(100vw-2rem))] space-y-3 text-sm">
            <div>
              <p className="label">最终提示词（{compiled.prompt.length} 字）</p>
              <p className="max-h-48 overflow-auto rounded-lg bg-black/30 p-2.5 leading-relaxed whitespace-pre-wrap">{compiled.prompt || '（空）'}</p>
            </div>
            {compiled.negativePrompt && (
              <div>
                <p className="label">反向提示词</p>
                <p className="rounded-lg bg-black/30 p-2.5 text-fg-2">{compiled.negativePrompt}</p>
              </div>
            )}
            <p className="text-xs text-fg-3">
              {compiled.params.width}×{compiled.params.height} · {compiled.params.aspectRatio}
              {mode === 'video' ? ` · ${compiled.params.duration} 秒` : ` · ${compiled.params.count} 张`}
              {compiled.params.seed != null && ` · 种子 ${compiled.params.seed}`}
              {compiled.presets.length > 0 && ` · 预设：${compiled.presets.map((slug) => presetMap.get(slug)?.name).join('、')}`}
            </p>
          </Popover>
        </div>
      </div>

      {/* 诊断与警告 */}
      {(visibleHints.length > 0 || compiled.warnings.length > 0 || down) && (
        <div className="mt-2 space-y-1 text-xs">
          {down && <p className="text-warn">{mode === 'image' ? '图像' : '视频'}生成服务暂不可用，任务会先进入队列，恢复后自动生成。</p>}
          {compiled.warnings.map((warning) => (
            <p key={warning} className="text-fg-3">· {warning}</p>
          ))}
          {visibleHints.map((hint) => (
            <p key={hint.code + hint.message} className={cx('flex flex-wrap items-center gap-2', hint.level === 'warn' ? 'text-warn' : 'text-fg-3')}>
              <span>💡 {hint.message}</span>
              {hint.fix && (
                <button className="rounded border border-current px-1.5 py-0.5" onClick={() => composer.set({ recipe: applyMoveToNegative(recipe, hint.fix!.phrase, hint.fix!.replacement) })}>
                  移到反向
                </button>
              )}
            </p>
          ))}
        </div>
      )}

      <PresetPanel composer={composer} open={presetTab !== null} onClose={() => setPresetTab(null)} initialTab={presetTab ?? 'style'} />
      <AiResults
        open={aiResult !== null}
        title={aiResult?.title ?? ''}
        items={aiResult?.items ?? []}
        onClose={() => setAiResult(null)}
        onPick={(text) => {
          composer.setRecipe({ text, ...(template && !recipe.text.trim() ? { templateId: null, presets: compiled.presets } : {}) });
          setAiResult(null);
        }}
      />
      <AssetPicker
        open={picker !== null}
        onClose={() => setPicker(null)}
        max={picker === 'ref' ? Math.max(1, caps.image.maxReferences - state.refs.length) : 1}
        title={picker === 'ref' ? '选择参考图' : picker === 'first' ? '选择首帧' : '选择尾帧'}
        onPick={(picked) => {
          if (picker === 'ref') composer.set({ refs: [...state.refs, ...picked].slice(0, caps.image.maxReferences) });
          if (picker === 'first') composer.set({ firstFrame: picked[0] });
          if (picker === 'last') composer.set({ lastFrame: picked[0] });
        }}
      />
    </div>
  );
}

/** 页面底部的输入区：桌面直接展开；手机收起成一行，点开是全屏面板 */
export function ComposerDock({ composer }: { composer: ComposerModel }) {
  const [expanded, setExpanded] = useState(false);
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)');
    const onChange = () => setMobile(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  if (!mobile) return <ComposerPanel composer={composer} />;
  return (
    <>
      <ComposerPanel composer={composer} compact={{ onExpand: () => setExpanded(true) }} />
      <Modal open={expanded} onClose={() => setExpanded(false)} bare>
        <div className="rounded-t-2xl bg-ink-1 p-2 pb-safe">
          <div className="mb-1 flex justify-center">
            <button aria-label="收起" className="flex h-6 w-12 items-center justify-center text-fg-3" onClick={() => setExpanded(false)}>
              <ChevronUp className="size-4 rotate-180" />
            </button>
          </div>
          <ComposerPanel composer={composer} onSubmitted={() => setExpanded(false)} />
        </div>
      </Modal>
    </>
  );
}
