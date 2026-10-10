// 灵感页：热门 / 精选 / 收藏 / 我的提示词；选一个模板，填变量，一键套用或直接生成
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Film, Heart, Image as ImageIcon, Search, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { compose, emptyRecipe } from '../../../../shared/compose.ts';
import type { PromptTemplate, Recipe } from '../../../../shared/presets.ts';
import type { Asset } from '../../../../shared/types.ts';
import { Button, Empty, IconButton, Media, Modal, Segmented, Spinner } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { imageParams, videoParams } from '../../lib/presets.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { cx } from '../../lib/util.ts';
import { useCatalog } from './create/catalog.ts';

type Tab = 'hot' | 'featured' | 'favorite' | 'mine';

/** 用过这个模板的最新一张作品当封面 */
function useCovers(): Map<string, Asset> {
  const assets = useStore((s) => s.assets);
  return useMemo(() => {
    const map = new Map<string, Asset>();
    for (const asset of Object.values(assets).sort((a, b) => b.createdAt - a.createdAt)) {
      const id = asset.gen?.templateId;
      if (id && !map.has(id)) map.set(id, asset);
    }
    return map;
  }, [assets]);
}

function TemplateTile({ template, cover, onOpen, onFavorite }: { template: PromptTemplate; cover?: Asset; onOpen: () => void; onFavorite: () => void }) {
  return (
    <div className="group panel relative flex flex-col overflow-hidden transition-colors hover:border-line-strong">
      <button onClick={onOpen} aria-label={`打开模板 ${template.name}`} className="dots-bg relative aspect-[4/3] w-full overflow-hidden bg-ink-2 text-left">
        {cover ? (
          <Media asset={cover} />
        ) : (
          <div className="flex size-full flex-col justify-end p-3">
            <span className="text-lg font-semibold tracking-tight">{template.name}</span>
            <span className="mt-0.5 line-clamp-2 text-xs text-fg-3">{template.body.replace(/[{}]/g, '')}</span>
          </div>
        )}
        <span className="absolute top-2 left-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] backdrop-blur">
          {template.mode === 'video' ? <Film className="size-3" /> : <ImageIcon className="size-3" />}
          {template.mode === 'video' ? '视频' : '图片'}
        </span>
        {template.featured && <span className="absolute top-2 right-9 rounded bg-accent px-1.5 py-0.5 text-[10px] text-white">精选</span>}
      </button>
      <IconButton label={template.favorite ? '取消收藏' : '收藏'} className="glass absolute top-1.5 right-1.5 size-7" onClick={onFavorite}>
        <Heart className={cx('size-3.5', template.favorite && 'fill-current text-danger')} />
      </IconButton>
      <button onClick={onOpen} className="p-3 text-left">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {template.name}
          {template.requiresReference && <span className="rounded bg-white/[0.08] px-1 text-[10px] font-normal text-fg-3">需要上传图片</span>}
        </p>
        <p className="mt-0.5 line-clamp-1 text-xs text-fg-3">
          {template.category} · {template.description}
        </p>
      </button>
    </div>
  );
}

function TemplateDetail({ template, onClose }: { template: PromptTemplate | null; onClose: () => void }) {
  const navigate = useNavigate();
  const caps = useStore((s) => s.capabilities);
  const health = useStore((s) => s.health);
  const setDraft = useStore((s) => s.setComposerDraft);
  const upsertTasks = useStore((s) => s.upsertTasks);
  const toast = useStore((s) => s.toast);
  const presetMap = useCatalog((s) => s.presetMap);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [idea, setIdea] = useState('');
  const [busy, setBusy] = useState<null | 'fill' | 'run'>(null);

  useEffect(() => {
    setVars({});
    setIdea('');
  }, [template]);

  if (!template) return null;
  const recipe: Recipe = { ...emptyRecipe(template.mode), templateId: template.id, vars };
  const compiled = compose({ recipe, template, catalog: presetMap, caps });

  function apply() {
    setDraft({ mode: template!.mode, recipe });
    onClose();
    navigate('/studio/create');
  }

  async function generate() {
    if (template!.requiresReference) return apply();
    setBusy('run');
    try {
      const base = template!.mode === 'video' ? videoParams('16:9', '720p', {}, caps) : imageParams('1:1', '1k', {}, caps);
      const task = await api.createTask({ type: template!.mode === 'video' ? 't2v' : 't2i', prompt: '', params: { ...base, ...compiled.params }, recipe, runNow: true });
      upsertTasks([task]);
      toast('已提交，去创作页看结果', 'success');
      onClose();
      navigate('/studio/create');
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }

  async function fill() {
    if (!idea.trim()) return;
    setBusy('fill');
    try {
      const result = await api.assist<{ vars: Record<string, string> }>('fill', { idea, body: template!.body, variables: template!.variables });
      setVars((prev) => ({ ...prev, ...result.vars }));
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open onClose={onClose} title={template.name}>
      <p className="-mt-2 mb-4 text-sm text-fg-3">
        {template.description}
        {template.requiresReference && `（需要先上传一张${template.mode === 'video' ? '首帧图片' : '参考图'}）`}
      </p>
      {template.variables.length > 0 && (
        <div className="space-y-2.5">
          {template.variables.map((variable) => (
            <div key={variable.key}>
              <label className="label">{variable.label}</label>
              <input
                className="field text-sm"
                value={vars[variable.key] ?? ''}
                placeholder={variable.default ?? variable.placeholder}
                onChange={(e) => setVars({ ...vars, [variable.key]: e.target.value })}
              />
              {variable.options && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {variable.options.map((option) => (
                    <button key={option} className="chip !h-6 !px-2 !text-[11px]" data-active={(vars[variable.key] || variable.default) === option} onClick={() => setVars({ ...vars, [variable.key]: option })}>
                      {option}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {health?.llm && (
            <div className="flex gap-2 pt-1">
              <input className="field text-sm" value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="一句话说想要什么，AI 帮你填" />
              <Button variant="secondary" loading={busy === 'fill'} icon={<Wand2 className="size-4" />} onClick={() => void fill()}>
                AI 填写
              </Button>
            </div>
          )}
        </div>
      )}
      <div className="mt-4 rounded-lg bg-black/30 p-3">
        <p className="label">最终提示词预览</p>
        <p className="text-sm leading-relaxed text-fg-2">{compiled.prompt}</p>
        <p className="mt-2 text-xs text-fg-3">
          {compiled.params.aspectRatio} · {compiled.params.width}×{compiled.params.height}
          {template.mode === 'video' && ` · ${compiled.params.duration} 秒`}
          {compiled.presets.length > 0 && ` · ${compiled.presets.map((slug) => presetMap.get(slug)?.name).join('、')}`}
        </p>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={apply}>
          套用到创作台 <ArrowRight className="size-4" />
        </Button>
        <Button variant="brand" loading={busy === 'run'} icon={<Sparkles className="size-4" />} onClick={() => void generate()}>
          {template.requiresReference ? '去上传图片' : '直接生成'}
        </Button>
      </div>
    </Modal>
  );
}

export default function Inspire() {
  const load = useCatalog((s) => s.load);
  const loaded = useCatalog((s) => s.loaded);
  const templates = useCatalog((s) => s.templates);
  const prompts = useCatalog((s) => s.prompts);
  const setTemplateFavorite = useCatalog((s) => s.setTemplateFavorite);
  const removePrompt = useCatalog((s) => s.removePrompt);
  const setDraft = useStore((s) => s.setComposerDraft);
  const navigate = useNavigate();
  const covers = useCovers();
  const [tab, setTab] = useState<Tab>('hot');
  const [mode, setMode] = useState<'all' | 'image' | 'video'>('all');
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<PromptTemplate | null>(null);

  useEffect(() => {
    void load(true);
  }, [load]);

  const categories = useMemo(() => [...new Set(templates.map((t) => t.category))], [templates]);
  const list = useMemo(() => {
    let items = templates.filter((t) => (mode === 'all' || t.mode === mode) && (!category || t.category === category));
    if (q.trim()) items = items.filter((t) => `${t.name}${t.description}${t.category}${t.body}`.includes(q.trim()));
    if (tab === 'featured') items = items.filter((t) => t.featured);
    if (tab === 'favorite') items = items.filter((t) => t.favorite);
    return tab === 'hot' ? [...items].sort((a, b) => (b.hot ?? 0) - (a.hot ?? 0) || a.sort - b.sort) : items;
  }, [templates, mode, category, q, tab]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 md:py-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">灵感</h1>
          <p className="mt-1 text-sm text-fg-3">挑一个效果模板，填几个词就能出图出视频。</p>
        </div>
        <label className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
          <input className="field !pl-9 text-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索模板，例如：海报、美食" />
        </label>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'hot', label: '热门' },
            { value: 'featured', label: '精选' },
            { value: 'favorite', label: '收藏' },
            { value: 'mine', label: '我的提示词' },
          ]}
        />
        {tab !== 'mine' && (
          <Segmented
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'all', label: '全部' },
              { value: 'image', label: '图片' },
              { value: 'video', label: '视频' },
            ]}
          />
        )}
      </div>
      {tab !== 'mine' && (
        <div className="no-scrollbar -mx-4 mb-5 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
          <button className="chip !h-7 shrink-0 !text-xs" data-active={!category} onClick={() => setCategory('')}>
            全部分类
          </button>
          {categories.map((c) => (
            <button key={c} className="chip !h-7 shrink-0 !text-xs" data-active={category === c} onClick={() => setCategory(category === c ? '' : c)}>
              {c}
            </button>
          ))}
        </div>
      )}

      {!loaded ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : tab === 'mine' ? (
        prompts.length === 0 ? (
          <Empty icon={<Sparkles className="size-6" />} title="还没有保存的提示词" hint="在作品详情里点“保存提示词”，好用的描述就会出现在这里" />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {prompts.map((p) => (
              <div key={p.id} className="panel flex flex-col p-3">
                <p className="text-sm font-medium">{p.name}</p>
                <p className="mt-1 line-clamp-3 flex-1 text-xs text-fg-3">{p.body}</p>
                <div className="mt-2 flex gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setDraft({ mode: p.mode, recipe: { ...emptyRecipe(p.mode), text: p.body } });
                      navigate('/studio/create');
                    }}
                  >
                    使用
                  </Button>
                  <IconButton label="删除" className="size-8" onClick={() => void removePrompt(p.id).catch(reportError)}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        )
      ) : list.length === 0 ? (
        <Empty icon={<Search className="size-6" />} title={tab === 'favorite' ? '还没有收藏的模板' : '没有找到模板'} />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {list.map((template) => (
            <TemplateTile key={template.id} template={template} cover={covers.get(template.id)} onOpen={() => setOpen(template)} onFavorite={() => void setTemplateFavorite(template.id, !template.favorite)} />
          ))}
        </div>
      )}

      <TemplateDetail template={open} onClose={() => setOpen(null)} />
    </div>
  );
}
