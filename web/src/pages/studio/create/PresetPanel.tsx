// 预设面板：模板、风格、光线、镜头、运镜、色调、负向、尺寸、我的提示词与最近使用
import { useEffect, useMemo, useState } from 'react';
import { Check, Clock, Film, Heart, Image as ImageIcon, Search, Trash2 } from 'lucide-react';
import { togglePreset } from '../../../../../shared/compose.ts';
import type { MediaMode, Preset, PresetKind, PromptTemplate, Recipe } from '../../../../../shared/presets.ts';
import { Button, IconButton, Modal } from '../../../components/ui.tsx';
import { api } from '../../../lib/api.ts';
import { reportError, useStore } from '../../../lib/store.ts';
import { cx, timeAgo } from '../../../lib/util.ts';
import { useCatalog } from './catalog.ts';
import type { Composer } from './useComposer.ts';

export type PanelTab = 'template' | 'style' | 'lighting' | 'framing' | 'motion' | 'tone' | 'negative' | 'scene' | 'mine';

const TABS: { id: PanelTab; label: string; kinds: PresetKind[]; videoOnly?: boolean }[] = [
  { id: 'template', label: '模板', kinds: [] },
  { id: 'style', label: '风格', kinds: ['style'] },
  { id: 'lighting', label: '光线', kinds: ['lighting'] },
  { id: 'framing', label: '镜头', kinds: ['shot', 'angle', 'layout'] },
  { id: 'motion', label: '运镜', kinds: ['camera', 'speed'], videoOnly: true },
  { id: 'tone', label: '色调', kinds: ['tone'] },
  { id: 'negative', label: '负向', kinds: ['negative'] },
  { id: 'scene', label: '尺寸', kinds: ['scene'] },
  { id: 'mine', label: '我的', kinds: [] },
];

const KIND_TITLE: Partial<Record<PresetKind, string>> = { shot: '景别', angle: '角度', layout: '构图', camera: '运镜', speed: '速度' };

/** 套用模板：模式不同时先切换模式 */
export function applyTemplate(composer: Composer, template: PromptTemplate): void {
  const base = composer.mode === template.mode ? composer.state.recipe : null;
  const recipe: Recipe = {
    version: 1,
    mode: template.mode,
    // 套用模板后正文变成“补充描述”，默认清空
    text: '',
    templateId: template.id,
    vars: {},
    // 模板自带的预设由编译器加上；用户之前选的同组预设会覆盖模板的
    presets: base?.presets.filter((slug) => !template.presets.includes(slug)) ?? [],
    negative: base?.negative ?? '',
    overrides: { ...(template.params.aspectRatio ? {} : { aspectRatio: base?.overrides.aspectRatio }), seed: base?.overrides.seed ?? null },
  };
  if (composer.mode !== template.mode) composer.load({ mode: template.mode, recipe });
  else composer.set({ recipe });
}

function PresetChip({ preset, selected, fromTemplate, disabled, onClick }: { preset: Preset; selected: boolean; fromTemplate: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cx(
        'flex min-h-14 flex-col items-start justify-center rounded-lg border px-3 py-2 text-left transition-colors',
        selected ? 'border-accent/70 bg-accent/12' : 'border-line bg-white/[0.03] hover:border-line-strong',
        disabled && 'cursor-not-allowed opacity-35',
      )}
      title={preset.prompt || preset.negative}
    >
      <span className="flex w-full items-center gap-1 text-[13px]">
        {preset.name}
        {fromTemplate && <span className="rounded bg-white/[0.08] px-1 text-[10px] text-fg-3">模板</span>}
        {selected && <Check className="ml-auto size-3.5 text-accent" />}
      </span>
      {preset.hint && <span className="mt-0.5 line-clamp-1 text-[11px] text-fg-3">{preset.hint}</span>}
    </button>
  );
}

function TemplateCard({ template, active, onUse, onFavorite }: { template: PromptTemplate; active: boolean; onUse: () => void; onFavorite: () => void }) {
  return (
    <div className={cx('flex flex-col rounded-lg border p-3', active ? 'border-accent/70 bg-accent/10' : 'border-line bg-white/[0.03]')}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-fg-3">{template.mode === 'video' ? <Film className="size-3.5" /> : <ImageIcon className="size-3.5" />}</span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            {template.name}
            {template.featured && <span className="rounded bg-accent/15 px-1 text-[10px] text-accent">精选</span>}
            {template.requiresReference && <span className="rounded bg-white/[0.08] px-1 text-[10px] text-fg-3">需要参考图</span>}
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs text-fg-3">{template.description}</p>
        </div>
        <IconButton label={template.favorite ? '取消收藏' : '收藏'} className="size-7" onClick={onFavorite}>
          <Heart className={cx('size-3.5', template.favorite && 'fill-current text-danger')} />
        </IconButton>
      </div>
      <Button size="sm" variant={active ? 'secondary' : 'ghost'} className="mt-2 self-start" onClick={onUse}>
        {active ? '正在使用' : '使用'}
      </Button>
    </div>
  );
}

export function PresetPanel({ composer, open, onClose, initialTab = 'style' }: { composer: Composer; open: boolean; onClose: () => void; initialTab?: PanelTab }) {
  const presets = useCatalog((s) => s.presets);
  const presetMap = useCatalog((s) => s.presetMap);
  const templates = useCatalog((s) => s.templates);
  const prompts = useCatalog((s) => s.prompts);
  const setTemplateFavorite = useCatalog((s) => s.setTemplateFavorite);
  const removePrompt = useCatalog((s) => s.removePrompt);
  const toast = useStore((s) => s.toast);
  const [tab, setTab] = useState<PanelTab>(initialTab);
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<{ recipe: Recipe; prompt: string; createdAt: number }[] | null>(null);
  const { mode, state } = composer;
  const template = templates.find((t) => t.id === state.recipe.templateId) ?? null;

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  useEffect(() => {
    if (open && tab === 'mine' && !recent) api.recentRecipes().then(setRecent, reportError);
  }, [open, tab, recent]);

  const visibleTabs = TABS.filter((t) => !t.videoOnly || mode === 'video');
  const current = visibleTabs.find((t) => t.id === tab) ?? visibleTabs[1];
  const selected = new Set([...(template?.presets ?? []), ...state.recipe.presets]);
  const effective = new Set(composer.compiled.presets);

  const groups = useMemo(() => {
    const list = presets.filter((p) => current.kinds.includes(p.kind));
    return current.kinds.map((kind) => ({ kind, items: list.filter((p) => p.kind === kind) })).filter((g) => g.items.length);
  }, [presets, current]);

  const filteredTemplates = templates.filter((t) => !query || t.name.includes(query) || t.description.includes(query) || t.category.includes(query));

  function toggle(slug: string) {
    // 模板自带、现在生效的预设：再点一次表示不要，用同组的“无”替代不了，这里只能提示
    if (template?.presets.includes(slug) && !state.recipe.presets.includes(slug)) {
      toast('这是模板自带的预设，换成同一组的其他选项即可替换', 'info');
      return;
    }
    composer.setRecipe({ presets: togglePreset(state.recipe.presets, slug, presetMap) });
  }

  return (
    <Modal open={open} onClose={onClose} title="预设与模板" wide>
      <div className="no-scrollbar -mx-1 mb-4 flex gap-1 overflow-x-auto px-1">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cx('h-8 shrink-0 rounded-md px-3 text-[13px]', current.id === t.id ? 'bg-white/[0.1] text-fg' : 'text-fg-3 hover:text-fg-2')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {current.id === 'template' && (
        <div>
          <label className="relative mb-3 block">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
            <input className="field !pl-9 text-sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模板" />
          </label>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {filteredTemplates.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                active={t.id === template?.id}
                onFavorite={() => void setTemplateFavorite(t.id, !t.favorite)}
                onUse={() => {
                  applyTemplate(composer, t);
                  onClose();
                }}
              />
            ))}
          </div>
        </div>
      )}

      {current.kinds.length > 0 && (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.kind}>
              {groups.length > 1 && <p className="label">{KIND_TITLE[group.kind]}</p>}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {group.items.map((preset) => (
                  <PresetChip
                    key={preset.slug}
                    preset={preset}
                    selected={selected.has(preset.slug) && (effective.has(preset.slug) || preset.applies !== mode)}
                    fromTemplate={Boolean(template?.presets.includes(preset.slug))}
                    disabled={preset.applies !== 'both' && preset.applies !== mode}
                    onClick={() => toggle(preset.slug)}
                  />
                ))}
              </div>
            </div>
          ))}
          <p className="text-xs text-fg-3">同一组只能选一个，选新的会替换旧的；负向可以多选。灰色的选项不适用于当前模式。</p>
        </div>
      )}

      {current.id === 'mine' && (
        <div className="grid gap-4 md:grid-cols-2">
          <section>
            <p className="label">我的提示词</p>
            {prompts.length === 0 ? (
              <p className="py-4 text-sm text-fg-3">还没有保存的提示词。在大图详情里点“保存提示词”，或在下方保存当前输入。</p>
            ) : (
              <ul className="space-y-1.5">
                {prompts.map((p) => (
                  <li key={p.id} className="flex items-start gap-2 rounded-lg border border-line bg-white/[0.03] p-2.5">
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={() => {
                        composer.setRecipe({ text: p.body });
                        onClose();
                      }}
                    >
                      <p className="text-sm">{p.name}</p>
                      <p className="line-clamp-2 text-xs text-fg-3">{p.body}</p>
                    </button>
                    <IconButton label="删除" className="size-7" onClick={() => void removePrompt(p.id).catch(reportError)}>
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
            {state.recipe.text.trim() && (
              <Button
                size="sm"
                variant="secondary"
                className="mt-3"
                onClick={async () => {
                  try {
                    const name = state.recipe.text.trim().slice(0, 16);
                    useCatalog.getState().addPrompt(await api.savePrompt(name, state.recipe.text.trim(), mode));
                    toast('已保存到我的提示词', 'success');
                  } catch (error) {
                    reportError(error);
                  }
                }}
              >
                保存当前输入
              </Button>
            )}
          </section>
          <section>
            <p className="label">最近使用</p>
            {!recent ? (
              <p className="py-4 text-sm text-fg-3">加载中…</p>
            ) : recent.length === 0 ? (
              <p className="py-4 text-sm text-fg-3">还没有用新版创作台生成过</p>
            ) : (
              <ul className="space-y-1.5">
                {recent.map((item) => (
                  <li key={item.createdAt}>
                    <button
                      className="w-full rounded-lg border border-line bg-white/[0.03] p-2.5 text-left hover:border-line-strong"
                      onClick={() => {
                        composer.load({ mode: item.recipe.mode, recipe: { ...item.recipe, overrides: { ...item.recipe.overrides, seed: null } } });
                        onClose();
                      }}
                    >
                      <p className="line-clamp-2 text-sm">{item.prompt}</p>
                      <p className="mt-1 flex items-center gap-1 text-xs text-fg-3">
                        <Clock className="size-3" /> {timeAgo(item.createdAt)} · {item.recipe.mode === 'video' ? '视频' : '图片'}
                        {item.recipe.templateId && ` · ${templates.find((t) => t.id === item.recipe.templateId)?.name ?? '模板'}`}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

/** 小标签：已选的预设（可以单独去掉） */
export function SelectedPresets({ composer, onOpen }: { composer: Composer; onOpen: (tab: PanelTab) => void }) {
  const presetMap = useCatalog((s) => s.presetMap);
  const templates = useCatalog((s) => s.templates);
  const { state } = composer;
  const template = templates.find((t) => t.id === state.recipe.templateId);
  const slugs = composer.compiled.presets;
  if (!slugs.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {slugs.map((slug) => {
        const preset = presetMap.get(slug);
        if (!preset) return null;
        const fromTemplate = Boolean(template?.presets.includes(slug)) && !state.recipe.presets.includes(slug);
        return (
          <span key={slug} className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-white/[0.04] pr-1 pl-2 text-[11px] text-fg-2">
            <button onClick={() => onOpen(tabOf(preset.kind))}>{preset.name}</button>
            {!fromTemplate && (
              <button
                aria-label={`去掉${preset.name}`}
                className="flex size-4 items-center justify-center rounded text-fg-3 hover:bg-white/[0.08] hover:text-fg"
                onClick={() => composer.setRecipe({ presets: state.recipe.presets.filter((s) => s !== slug) })}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

export function tabOf(kind: PresetKind): PanelTab {
  return TABS.find((t) => t.kinds.includes(kind))?.id ?? 'style';
}

export type { MediaMode };
