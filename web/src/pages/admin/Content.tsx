// 内容管理：预设（改词、上下架）和提示词模板（新建、编辑、精选、上下架）
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Search, Star } from 'lucide-react';
import { templateVariables } from '../../../../shared/compose.ts';
import { PRESET_KIND_LABEL, type Preset, type PresetKind, type PromptTemplate, type TemplateVariable } from '../../../../shared/presets.ts';
import { Button, IconButton, Modal, Segmented, Spinner, Toggle } from '../../components/ui.tsx';
import { adminApi, type TemplateInput } from '../../lib/adminApi.ts';
import { reportError, useStore } from '../../lib/store.ts';
import { cx } from '../../lib/util.ts';
import { useCatalog } from '../studio/create/catalog.ts';
import { PageHeader } from './AdminLayout.tsx';

type Tab = 'templates' | 'presets';

export default function AdminContent() {
  const [tab, setTab] = useState<Tab>('templates');
  return (
    <div>
      <PageHeader title="内容" hint="预设和模板改完立即生效（客户端下次加载目录时拿到新版本）。改过的条目不会被内置数据覆盖。" />
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'templates', label: '模板' },
          { value: 'presets', label: '预设' },
        ]}
      />
      <div className="mt-4">{tab === 'templates' ? <Templates /> : <Presets />}</div>
    </div>
  );
}

/** 后台改动后让工作台的目录缓存失效 */
function refreshCatalog() {
  void useCatalog.getState().load(true);
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="relative block sm:w-64">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
      <input className="field !pl-9 text-sm" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </label>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-fg-3">
        {label}
        {hint && <span className="ml-2 text-fg-3/70">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

// ---------------- 预设 ----------------

function Presets() {
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<Preset[] | null>(null);
  const [kind, setKind] = useState<PresetKind | 'all'>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Preset | null>(null);
  const load = useCallback(() => adminApi.presets().then(setList, reportError), []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () => (list ?? []).filter((p) => (kind === 'all' || p.kind === kind) && (!q || `${p.name}${p.slug}${p.prompt}`.toLowerCase().includes(q.toLowerCase()))),
    [list, kind, q],
  );

  async function patch(preset: Preset, change: Parameters<typeof adminApi.updatePreset>[1], message = '已保存') {
    try {
      const updated = await adminApi.updatePreset(preset.slug, change);
      setList((current) => current?.map((p) => (p.slug === updated.slug ? updated : p)) ?? null);
      refreshCatalog();
      toast(message, 'success');
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  }

  if (!list)
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="名称、slug 或提示词" />
        <div className="no-scrollbar flex gap-1 overflow-x-auto">
          {(['all', ...Object.keys(PRESET_KIND_LABEL)] as (PresetKind | 'all')[]).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={cx('h-8 shrink-0 rounded-md px-2.5 text-xs', kind === k ? 'bg-white/[0.08] text-fg' : 'text-fg-3 hover:text-fg')}
            >
              {k === 'all' ? '全部' : PRESET_KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </div>
      <div className="panel divide-y divide-line">
        {shown.map((preset) => (
          <div key={preset.slug} className={cx('flex items-center gap-3 px-4 py-2.5', !preset.enabled && 'opacity-50')}>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm">
                {preset.name}
                <span className="rounded bg-white/[0.06] px-1.5 text-[11px] text-fg-3">{PRESET_KIND_LABEL[preset.kind]}</span>
                {preset.applies !== 'both' && <span className="text-[11px] text-fg-3">{preset.applies === 'image' ? '仅图片' : '仅视频'}</span>}
              </p>
              <p className="truncate text-xs text-fg-3">{preset.prompt || preset.negative || '—'}</p>
            </div>
            <IconButton label={`编辑 ${preset.name}`} onClick={() => setEditing(preset)}>
              <Pencil className="size-4" />
            </IconButton>
            <Toggle label={`启用 ${preset.name}`} checked={preset.enabled} onChange={(on) => void patch(preset, { enabled: on }, on ? '已上架' : '已下架')} />
          </div>
        ))}
        {!shown.length && <p className="px-4 py-10 text-center text-sm text-fg-3">没有匹配的预设</p>}
      </div>
      {editing && <PresetForm preset={editing} onClose={() => setEditing(null)} onSave={(change) => patch(editing, change)} />}
    </>
  );
}

function PresetForm({ preset, onClose, onSave }: { preset: Preset; onClose: () => void; onSave: (change: Parameters<typeof adminApi.updatePreset>[1]) => Promise<boolean> }) {
  const [form, setForm] = useState({
    name: preset.name,
    prompt: preset.prompt,
    negative: preset.negative ?? '',
    fallbackPrompt: preset.fallbackPrompt ?? '',
    hint: preset.hint ?? '',
    sort: preset.sort,
  });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    setBusy(true);
    const ok = await onSave({ ...form, negative: form.negative || null, fallbackPrompt: form.fallbackPrompt || null, hint: form.hint || null });
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <Modal open onClose={onClose} title={`编辑预设 · ${preset.slug}`}>
      <div className="space-y-3">
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <Field label="名称">
            <input className="field text-sm" value={form.name} maxLength={30} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="排序">
            <input className="field text-sm" type="number" value={form.sort} onChange={(e) => set({ sort: Number(e.target.value) || 0 })} />
          </Field>
        </div>
        <Field label="正向片段">
          <textarea className="field min-h-20 text-sm" value={form.prompt} maxLength={500} onChange={(e) => set({ prompt: e.target.value })} />
        </Field>
        <Field label="反向片段">
          <textarea className="field min-h-16 text-sm" value={form.negative} maxLength={500} onChange={(e) => set({ negative: e.target.value })} />
        </Field>
        <Field label="不支持反向词时的替代" hint="追加到正向提示词">
          <input className="field text-sm" value={form.fallbackPrompt} maxLength={300} onChange={(e) => set({ fallbackPrompt: e.target.value })} />
        </Field>
        <Field label="一句话说明">
          <input className="field text-sm" value={form.hint} maxLength={60} onChange={(e) => set({ hint: e.target.value })} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="brand" loading={busy} disabled={!form.name.trim()} onClick={() => void save()}>
            保存
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------- 模板 ----------------

function Templates() {
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<PromptTemplate[] | null>(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<PromptTemplate | 'new' | null>(null);
  const load = useCallback(() => adminApi.templates().then(setList, reportError), []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = (list ?? []).filter((t) => !q || `${t.name}${t.id}${t.category}${t.body}`.toLowerCase().includes(q.toLowerCase()));

  async function patch(template: PromptTemplate, change: Partial<TemplateInput>, message: string) {
    try {
      const updated = await adminApi.updateTemplate(template.id, change);
      setList((current) => current?.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)) ?? null);
      refreshCatalog();
      toast(message, 'success');
    } catch (error) {
      reportError(error);
    }
  }

  if (!list)
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="名称、分类或正文" />
        <Button size="sm" variant="brand" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
          新建模板
        </Button>
      </div>
      <div className="panel divide-y divide-line">
        {shown.map((template) => (
          <div key={template.id} className={cx('flex items-center gap-3 px-4 py-2.5', !template.enabled && 'opacity-50')}>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                {template.name}
                <span className="rounded bg-white/[0.06] px-1.5 text-[11px] text-fg-3">{template.category}</span>
                <span className="text-[11px] text-fg-3">{template.mode === 'image' ? '图片' : '视频'}</span>
                {template.requiresReference && <span className="text-[11px] text-fg-3">需参考图</span>}
                <span className="text-[11px] text-fg-3">用过 {template.uses ?? 0} 次</span>
              </p>
              <p className="truncate text-xs text-fg-3">{template.body}</p>
            </div>
            <IconButton
              label={template.featured ? '取消精选' : '设为精选'}
              onClick={() => void patch(template, { featured: !template.featured }, template.featured ? '已取消精选' : '已设为精选')}
            >
              <Star className={cx('size-4', template.featured && 'fill-warn text-warn')} />
            </IconButton>
            <IconButton label={`编辑 ${template.name}`} onClick={() => setEditing(template)}>
              <Pencil className="size-4" />
            </IconButton>
            <Toggle
              label={`启用 ${template.name}`}
              checked={template.enabled}
              onChange={(on) => void patch(template, { enabled: on }, on ? '已上架' : '已下架')}
            />
          </div>
        ))}
        {!shown.length && <p className="px-4 py-10 text-center text-sm text-fg-3">没有匹配的模板</p>}
      </div>
      {editing && (
        <TemplateForm
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setList((current) => {
              const rest = (current ?? []).filter((t) => t.id !== saved.id);
              return editing === 'new' ? [...rest, saved] : (current ?? []).map((t) => (t.id === saved.id ? { ...t, ...saved } : t));
            });
            refreshCatalog();
            toast(editing === 'new' ? '已新建模板' : '已保存', 'success');
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function TemplateForm({ template, onClose, onSaved }: { template: PromptTemplate | null; onClose: () => void; onSaved: (t: PromptTemplate) => void }) {
  const presets = useCatalog((s) => s.presets);
  const [id, setId] = useState('');
  const [form, setForm] = useState<TemplateInput>(() =>
    template
      ? {
          name: template.name,
          category: template.category,
          description: template.description,
          mode: template.mode,
          body: template.body,
          variables: template.variables,
          negative: template.negative,
          presets: template.presets,
          params: template.params,
          requiresReference: template.requiresReference,
          featured: template.featured,
          enabled: template.enabled,
          sort: template.sort,
          cover: template.cover ?? null,
        }
      : {
          name: '',
          category: '我的',
          description: '',
          mode: 'image',
          body: '',
          variables: [],
          negative: '',
          presets: [],
          params: {},
          requiresReference: false,
          featured: false,
          enabled: true,
          sort: 999,
          cover: null,
        },
  );
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<TemplateInput>) => setForm((f) => ({ ...f, ...patch }));

  // 变量跟着正文里的 {变量} 走：新出现的补一行，删掉的去掉
  const keys = templateVariables(form.body);
  const variables: TemplateVariable[] = keys.map((key) => form.variables.find((v) => v.key === key) ?? { key, label: key });
  const setVar = (key: string, patch: Partial<TemplateVariable>) =>
    set({ variables: variables.map((v) => (v.key === key ? { ...v, ...patch } : v)) });
  const usable = presets.filter((p) => p.enabled && (p.applies === 'both' || p.applies === form.mode));

  async function save() {
    setBusy(true);
    try {
      const input = { ...form, variables: variables.map((v) => ({ ...v, label: v.label.trim() || v.key })) };
      onSaved(template ? await adminApi.updateTemplate(template.id, input) : await adminApi.createTemplate({ ...input, id }));
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={template ? `编辑模板 · ${template.id}` : '新建模板'} wide>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          {!template && (
            <Field label="ID" hint="小写字母、数字和横线，创建后不能改">
              <input className="field text-sm" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="my-template" />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="名称">
              <input className="field text-sm" value={form.name} maxLength={30} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="分类">
              <input className="field text-sm" value={form.category} maxLength={12} onChange={(e) => set({ category: e.target.value })} />
            </Field>
          </div>
          <Field label="一句话描述">
            <input className="field text-sm" value={form.description} maxLength={80} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <div className="flex flex-wrap items-center gap-4">
            <Segmented
              size="sm"
              value={form.mode}
              onChange={(mode) => set({ mode, presets: form.presets.filter((slug) => presets.find((p) => p.slug === slug)?.applies !== (mode === 'image' ? 'video' : 'image')) })}
              options={[
                { value: 'image', label: '图片' },
                { value: 'video', label: '视频' },
              ]}
            />
            <label className="flex items-center gap-2 text-xs text-fg-2">
              <Toggle checked={form.requiresReference} onChange={(v) => set({ requiresReference: v })} label="需要参考图" />
              需要参考图
            </label>
          </div>
          <Field label="正文" hint="用 {变量} 留空位">
            <textarea className="field min-h-28 text-sm" value={form.body} maxLength={1000} onChange={(e) => set({ body: e.target.value })} placeholder="{主体}站在{场景}里，……" />
          </Field>
          <Field label="反向提示词">
            <input className="field text-sm" value={form.negative} maxLength={500} onChange={(e) => set({ negative: e.target.value })} />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="比例">
              <input className="field text-sm" value={form.params.aspectRatio ?? ''} placeholder="默认" onChange={(e) => set({ params: { ...form.params, aspectRatio: e.target.value || undefined } })} />
            </Field>
            {form.mode === 'video' ? (
              <Field label="时长（秒）">
                <input
                  className="field text-sm"
                  type="number"
                  value={form.params.duration ?? ''}
                  onChange={(e) => set({ params: { ...form.params, duration: e.target.value ? Number(e.target.value) : undefined } })}
                />
              </Field>
            ) : (
              <Field label="张数">
                <input
                  className="field text-sm"
                  type="number"
                  min={1}
                  max={4}
                  value={form.params.count ?? ''}
                  onChange={(e) => set({ params: { ...form.params, count: e.target.value ? Math.min(4, Math.max(1, Number(e.target.value))) : undefined } })}
                />
              </Field>
            )}
            <Field label="排序">
              <input className="field text-sm" type="number" value={form.sort} onChange={(e) => set({ sort: Number(e.target.value) || 0 })} />
            </Field>
          </div>
        </div>
        <div className="space-y-3">
          <div>
            <p className="mb-1 text-xs text-fg-3">变量 {variables.length ? `（${variables.length}）` : ''}</p>
            {!variables.length && <p className="text-xs text-fg-3">正文里还没有 {'{变量}'}。</p>}
            <div className="space-y-2">
              {variables.map((v) => (
                <div key={v.key} className="rounded-lg border border-line p-2.5">
                  <p className="mb-1.5 font-mono text-xs text-accent">{`{${v.key}}`}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <input className="field text-xs" aria-label={`${v.key} 显示名`} placeholder="显示名" value={v.label} maxLength={16} onChange={(e) => setVar(v.key, { label: e.target.value })} />
                    <input className="field text-xs" aria-label={`${v.key} 默认值`} placeholder="默认值" value={v.default ?? ''} maxLength={100} onChange={(e) => setVar(v.key, { default: e.target.value || undefined })} />
                  </div>
                  <input
                    className="field mt-2 text-xs"
                    aria-label={`${v.key} 可选值`}
                    placeholder="可选值，用顿号或逗号分隔"
                    value={(v.options ?? []).join('、')}
                    onChange={(e) => {
                      const options = e.target.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
                      setVar(v.key, { options: options.length ? options : undefined });
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs text-fg-3">套用时一并选中的预设</p>
            <div className="flex max-h-44 flex-wrap gap-1.5 overflow-auto">
              {usable.map((p) => {
                const on = form.presets.includes(p.slug);
                return (
                  <button
                    key={p.slug}
                    onClick={() => set({ presets: on ? form.presets.filter((s) => s !== p.slug) : [...form.presets, p.slug] })}
                    className={cx('h-7 rounded-md border px-2 text-xs', on ? 'border-accent bg-accent/15 text-fg' : 'border-line text-fg-3 hover:text-fg')}
                  >
                    {PRESET_KIND_LABEL[p.kind]} · {p.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button variant="brand" loading={busy} disabled={!form.name.trim() || !form.body.trim() || (!template && !/^[a-z0-9-]{2,40}$/.test(id))} onClick={() => void save()}>
          {template ? '保存' : '创建'}
        </Button>
      </div>
    </Modal>
  );
}
