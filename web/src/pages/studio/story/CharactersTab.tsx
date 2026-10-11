// 设定库（STY-07）：角色、地点、道具、画风。描述会自动拼进镜头提示词，在分镜描述里输入 @ 可以提及。
import { useEffect, useState } from 'react';
import { Box, ImagePlus, Lock, MapPin, Palette, Plus, Share2, Sparkles, Trash2, UserRound, Wand2, X } from 'lucide-react';
import type { Character, ElementRef, Outfit, StoryElement } from '../../../../../shared/types.ts';
import { AssetPicker } from '../../../components/AssetPicker.tsx';
import { Button, Empty, IconButton, Media, ProgressBar, Segmented } from '../../../components/ui.tsx';
import { api } from '../../../lib/api.ts';
import { reportError, useStore } from '../../../lib/store.ts';
import { cx, uid } from '../../../lib/util.ts';
import { useShotGenerator, useStory } from './context.tsx';
import { newCharacter, newElement } from './model.ts';
import { confirmDialog, promptDialog } from '../../../components/ConfirmDialog.tsx';

const ROLES = ['主角', '配角', '反派', '群演'];
const REF_ROLES: Record<string, string> = { front: '正面', side: '侧面', full: '全身', expression: '表情', reference: '参考' };
type Section = 'character' | 'location' | 'prop' | 'style';

/** 别名：回车添加，点 × 删除 */
function AliasInput({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const [text, setText] = useState('');
  const add = () => {
    const name = text.trim();
    if (name && !value.includes(name)) onChange([...value, name]);
    setText('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((alias) => (
        <span key={alias} className="chip !h-6 !px-2 !text-[11px]">
          {alias}
          <button aria-label={`删除别名 ${alias}`} onClick={() => onChange(value.filter((a) => a !== alias))}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input className="field !h-6 !w-24 !px-2 !py-0 text-[11px]" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} onBlur={add} placeholder="加别名" />
    </div>
  );
}

/** 参考图：多张，每张标一个用途（正面 / 侧面 / 全身 / 表情） */
function RefGallery({ refs, onChange, storyId }: { refs: ElementRef[]; onChange: (refs: ElementRef[]) => void; storyId: string }) {
  const assets = useStore((s) => s.assets);
  const upsertAssets = useStore((s) => s.upsertAssets);
  const [picking, setPicking] = useState(false);
  return (
    <div>
      <p className="label">更多参考图</p>
      <div className="flex flex-wrap gap-1.5">
        {refs.map((ref, index) => {
          const asset = assets[ref.assetId];
          return (
            <div key={`${ref.assetId}-${index}`} className="relative w-14">
              <div className="aspect-[3/4] overflow-hidden rounded-md border border-line bg-ink-3">{asset && <Media asset={asset} variant="thumb" />}</div>
              <select
                className="mt-0.5 w-full rounded bg-transparent text-[10px] text-fg-3"
                value={ref.role}
                onChange={(e) => onChange(refs.map((r, i) => (i === index ? { ...r, role: e.target.value } : r)))}
                aria-label="参考图用途"
              >
                {Object.entries(REF_ROLES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button aria-label="移除参考图" onClick={() => onChange(refs.filter((_, i) => i !== index))} className="absolute -top-1 -right-1 rounded-full bg-black/80 p-0.5 text-fg-2 hover:text-danger">
                <X className="size-3" />
              </button>
            </div>
          );
        })}
        <button onClick={() => setPicking(true)} className="flex aspect-[3/4] w-14 items-center justify-center rounded-md border border-dashed border-line text-fg-3 hover:border-line-strong hover:text-fg" aria-label="添加参考图">
          <Plus className="size-4" />
        </button>
      </div>
      <AssetPicker
        open={picking}
        onClose={() => setPicking(false)}
        title="添加参考图"
        max={4}
        storyId={storyId}
        onPick={(picked) => {
          upsertAssets(picked);
          onChange([...refs, ...picked.map((asset) => ({ assetId: asset.id, role: 'reference' }))]);
        }}
      />
    </div>
  );
}

function CharacterCard({ character, onPick, inSeries }: { character: Character; onPick: () => void; inSeries: boolean }) {
  const { storyId, update } = useStory();
  const generator = useShotGenerator();
  const assets = useStore((s) => s.assets);
  const tasks = useStore((s) => s.tasks);
  const [more, setMore] = useState(false);
  const shotKey = `char_${character.id}`;
  const portraits = Object.values(assets)
    .filter((a) => a.storyId === storyId && a.shotId === shotKey && !a.deletedAt && a.flag !== 'reject')
    .sort((a, b) => b.createdAt - a.createdAt);
  const active = Object.values(tasks).find((t) => t.link.shotId === shotKey && ['queued', 'running', 'paused'].includes(t.status));
  const reference = character.referenceAssetId ? assets[character.referenceAssetId] : null;
  const set = (patch: Partial<Character>) => update((d) => ({ ...d, characters: d.characters.map((c) => (c.id === character.id ? { ...c, ...patch } : c)) }));

  // 第一张定妆照生成后自动设为角色参考图
  useEffect(() => {
    if (!character.referenceAssetId && portraits[0]) set({ referenceAssetId: portraits[0].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portraits[0]?.id]);

  const outfits = character.outfits ?? [];

  return (
    <div className="panel flex flex-col overflow-hidden">
      <div className="flex gap-3 p-4">
        <div className="relative aspect-[3/4] w-24 shrink-0 overflow-hidden rounded-xl bg-ink-3 sm:w-28">
          {reference ? (
            <Media asset={reference} variant="thumb" />
          ) : (
            <div className="flex size-full items-center justify-center text-fg-3">
              <UserRound className="size-8" />
            </div>
          )}
          {active && (
            <div className="absolute inset-x-0 bottom-0 bg-black/60 p-1.5">
              <ProgressBar value={active.progress} />
            </div>
          )}
          {character.seriesShared && <Share2 className="absolute top-1 right-1 size-3.5 text-accent drop-shadow" aria-label="系列共享" />}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <input className="field !py-1.5 font-medium" value={character.name} onChange={(e) => set({ name: e.target.value })} aria-label="角色名" />
            <IconButton
              label="删除角色"
              className="hover:text-danger"
              onClick={async () =>
                (await confirmDialog({ title: `删除角色「${character.name}」？`, message: character.seriesShared ? '这是系列共享的角色，删除后其他集里也会消失。' : undefined, confirmText: '删除', danger: true })) &&
                update((d) => ({ ...d, characters: d.characters.filter((c) => c.id !== character.id) }))
              }
            >
              <Trash2 className="size-4" />
            </IconButton>
          </div>
          <div className="flex flex-wrap gap-1">
            {ROLES.map((role) => (
              <button key={role} className="chip !h-6 !px-2 !text-[11px]" data-active={character.role === role} onClick={() => set({ role })}>
                {role}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Button size="sm" icon={<Wand2 className="size-3.5" />} onClick={() => void generator.portrait(character)} disabled={Boolean(active)}>
              生成定妆照 ×4
            </Button>
            <Button size="sm" variant="ghost" icon={<ImagePlus className="size-3.5" />} onClick={onPick}>
              选择
            </Button>
          </div>
        </div>
      </div>
      <div className="space-y-2 px-4 pb-4">
        <div>
          <label className="label">外貌（拼进每个镜头的提示词，保持角色一致）</label>
          <textarea className="field resize-none text-sm" rows={3} value={character.appearance} onChange={(e) => set({ appearance: e.target.value })} placeholder="年龄、发型、服装、体态、标志性特征" />
        </div>
        {portraits.length > 1 && (
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto pt-1">
            {portraits.map((asset) => (
              <button
                key={asset.id}
                title="设为主参考图"
                onClick={() => set({ referenceAssetId: asset.id })}
                className={cx('aspect-[3/4] w-10 shrink-0 overflow-hidden rounded-md border-2', character.referenceAssetId === asset.id ? 'border-violet' : 'border-transparent')}
              >
                <Media asset={asset} variant="thumb" />
              </button>
            ))}
          </div>
        )}
        <button onClick={() => setMore((v) => !v)} className="text-xs text-accent hover:underline">
          {more ? '收起' : '别名、固定种子、服装、更多参考图…'}
        </button>
        {more && (
          <div className="space-y-3 border-t border-line pt-3">
            <div>
              <label className="label">性格 / 小传</label>
              <textarea className="field resize-none text-sm" rows={2} value={character.personality} onChange={(e) => set({ personality: e.target.value })} />
            </div>
            <div>
              <p className="label">别名（分镜里写别名也能识别）</p>
              <AliasInput value={character.aliases ?? []} onChange={(aliases) => set({ aliases })} />
            </div>
            <div>
              <p className="label">固定种子（定妆照和镜头都用它，脸型更稳定）</p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  className="field !w-36 !py-1 text-xs"
                  value={character.seed ?? ''}
                  placeholder="不固定"
                  onChange={(e) => set({ seed: e.target.value === '' ? null : Math.trunc(Number(e.target.value)) })}
                  aria-label="固定种子"
                />
                {reference?.gen?.seed != null && character.seed !== reference.gen.seed && (
                  <button className="flex items-center gap-1 text-xs text-accent hover:underline" onClick={() => set({ seed: reference.gen!.seed })}>
                    <Lock className="size-3" /> 用主参考图的种子
                  </button>
                )}
              </div>
            </div>
            <div>
              <p className="label">这个角色要避免的</p>
              <input className="field !py-1.5 text-xs" value={character.negative ?? ''} onChange={(e) => set({ negative: e.target.value })} placeholder="例如：浓妆，长发" />
            </div>
            <div>
              <p className="label">服装</p>
              <div className="space-y-1.5">
                {outfits.map((outfit: Outfit) => (
                  <div key={outfit.id} className="flex items-center gap-1.5">
                    <input className="field !w-24 !py-1 text-xs" value={outfit.name} onChange={(e) => set({ outfits: outfits.map((o) => (o.id === outfit.id ? { ...o, name: e.target.value } : o)) })} aria-label="服装名" />
                    <input className="field !py-1 text-xs" value={outfit.snippet} onChange={(e) => set({ outfits: outfits.map((o) => (o.id === outfit.id ? { ...o, snippet: e.target.value } : o)) })} placeholder="服装描述" aria-label="服装描述" />
                    <IconButton label="删除服装" className="size-7" onClick={() => set({ outfits: outfits.filter((o) => o.id !== outfit.id) })}>
                      <X className="size-3.5" />
                    </IconButton>
                  </div>
                ))}
                <button className="text-xs text-fg-3 hover:text-fg" onClick={() => set({ outfits: [...outfits, { id: uid('o_'), name: `服装 ${outfits.length + 1}`, snippet: '' }] })}>
                  + 添加服装
                </button>
              </div>
            </div>
            <RefGallery refs={character.refs ?? []} onChange={(refs) => set({ refs })} storyId={storyId} />
            {inSeries && (
              <label className="flex items-center gap-2 text-xs text-fg-2">
                <input type="checkbox" checked={Boolean(character.seriesShared)} onChange={(e) => set({ seriesShared: e.target.checked })} />
                在系列的所有集里共享这个角色
              </label>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const ELEMENT_META = {
  location: { label: '地点', icon: MapPin, placeholder: '环境描述：建筑、陈设、天气、光线……', hint: '场次可以关联地点，镜头里 @ 地点名也会带上这段描述。' },
  prop: { label: '道具', icon: Box, placeholder: '外观描述：材质、颜色、大小、磨损……', hint: '关键道具在镜头里 @ 一下，外观就会保持一致。' },
  style: { label: '画风', icon: Palette, placeholder: '画风描述：例如 水彩绘本，柔和的纸张纹理', hint: '除了故事的统一画风，个别镜头可以叠加额外的画风设定。' },
} as const;

function ElementCard({ element, inSeries }: { element: StoryElement; inSeries: boolean }) {
  const { storyId, update } = useStory();
  const assets = useStore((s) => s.assets);
  const [picking, setPicking] = useState(false);
  const upsertAssets = useStore((s) => s.upsertAssets);
  const set = (patch: Partial<StoryElement>) => update((d) => ({ ...d, elements: (d.elements ?? []).map((e) => (e.id === element.id ? { ...e, ...patch } : e)) }));
  const primary = element.refs?.[0] ? assets[element.refs[0].assetId] : null;
  const Icon = ELEMENT_META[element.kind].icon;
  return (
    <div className="panel space-y-2 p-4">
      <div className="flex items-center gap-2">
        <button onClick={() => setPicking(true)} className="relative aspect-square w-12 shrink-0 overflow-hidden rounded-lg border border-line bg-ink-3" title="选择参考图">
          {primary ? <Media asset={primary} variant="thumb" /> : <Icon className="m-auto size-5 text-fg-3" />}
        </button>
        <input className="field !py-1.5 font-medium" value={element.name} onChange={(e) => set({ name: e.target.value })} aria-label={`${ELEMENT_META[element.kind].label}名`} />
        <IconButton
          label="删除"
          className="hover:text-danger"
          onClick={async () => (await confirmDialog({ title: `删除「${element.name}」？`, confirmText: '删除', danger: true })) && update((d) => ({ ...d, elements: (d.elements ?? []).filter((e) => e.id !== element.id) }))}
        >
          <Trash2 className="size-4" />
        </IconButton>
      </div>
      <textarea className="field resize-none text-sm" rows={2} value={element.snippet} onChange={(e) => set({ snippet: e.target.value })} placeholder={ELEMENT_META[element.kind].placeholder} />
      <AliasInput value={element.aliases ?? []} onChange={(aliases) => set({ aliases })} />
      {element.kind === 'location' && (
        <div className="space-y-1">
          {(element.variants ?? []).map((variant) => (
            <div key={variant.id} className="flex items-center gap-1.5">
              <input className="field !w-20 !py-1 text-xs" value={variant.name} onChange={(e) => set({ variants: (element.variants ?? []).map((v) => (v.id === variant.id ? { ...v, name: e.target.value } : v)) })} aria-label="变体名" />
              <input className="field !py-1 text-xs" value={variant.snippet} onChange={(e) => set({ variants: (element.variants ?? []).map((v) => (v.id === variant.id ? { ...v, snippet: e.target.value } : v)) })} placeholder="例如：夜晚，霓虹灯亮起，地面积水" aria-label="变体描述" />
              <IconButton label="删除变体" className="size-7" onClick={() => set({ variants: (element.variants ?? []).filter((v) => v.id !== variant.id) })}>
                <X className="size-3.5" />
              </IconButton>
            </div>
          ))}
          <button className="text-xs text-fg-3 hover:text-fg" onClick={() => set({ variants: [...(element.variants ?? []), { id: uid('v_'), name: '夜晚', snippet: '' }] })}>
            + 时段 / 天气变体
          </button>
        </div>
      )}
      {inSeries && (
        <label className="flex items-center gap-2 text-xs text-fg-2">
          <input type="checkbox" checked={Boolean(element.seriesShared)} onChange={(e) => set({ seriesShared: e.target.checked })} />
          系列共享
        </label>
      )}
      <AssetPicker
        open={picking}
        onClose={() => setPicking(false)}
        title="选择参考图"
        storyId={storyId}
        onPick={([asset]) => {
          upsertAssets([asset]);
          set({ refs: [{ assetId: asset.id, role: 'primary' }, ...(element.refs ?? []).slice(1)] });
        }}
      />
    </div>
  );
}

export function CharactersTab({ inSeries = false }: { inSeries?: boolean }) {
  const { storyId, data, update, flushNow } = useStory();
  const [section, setSection] = useState<Section>('character');
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const toast = useStore((s) => s.toast);
  const elements = data.elements ?? [];

  async function generate() {
    if (!data.outline.trim() && !data.logline.trim()) {
      toast('先在「设定与大纲」里写好故事大纲', 'info');
      return;
    }
    setLoading(true);
    try {
      await flushNow?.();
      const result = await api.assist<{ characters: Omit<Character, 'id' | 'referenceAssetId'>[] }>('characters', {
        storyId,
        logline: data.logline,
        outline: data.outline,
        existing: data.characters.map((c) => c.name),
      });
      update((d) => {
        const names = new Set(d.characters.map((c) => c.name));
        const added = result.characters.filter((c) => !names.has(c.name)).map((c) => newCharacter(c));
        return { ...d, characters: [...d.characters, ...added] };
      });
    } catch (error) {
      reportError(error);
    } finally {
      setLoading(false);
    }
  }

  /** 从剧本（各场剧情和台词）里提取角色、地点、道具，只追加没有的 */
  async function extract() {
    const script = data.chapters
      .flatMap((c) => c.scenes)
      .map((s) => `【${s.title}｜${s.location}｜${s.time}】\n${s.summary}\n${s.dialogue.map((l) => `${data.characters.find((c) => c.id === l.characterId)?.name ?? '旁白'}：${l.text}`).join('\n')}`)
      .join('\n\n');
    if (!script.trim()) {
      toast('先写一些剧本内容', 'info');
      return;
    }
    setLoading(true);
    try {
      await flushNow?.();
      const result = await api.assist<{ characters: { name: string; role?: string; appearance?: string }[]; locations: { name: string; snippet: string }[]; props: { name: string; snippet: string }[] }>('extract', { storyId, script });
      let added = 0;
      update((d) => {
        const names = new Set([...d.characters.map((c) => c.name), ...(d.elements ?? []).map((e) => e.name)]);
        const characters = result.characters.filter((c) => !names.has(c.name)).map((c) => newCharacter({ name: c.name, role: c.role || '配角', appearance: c.appearance ?? '' }));
        const els = [
          ...result.locations.filter((l) => !names.has(l.name)).map((l) => newElement('location', { name: l.name, snippet: l.snippet })),
          ...result.props.filter((p) => !names.has(p.name)).map((p) => newElement('prop', { name: p.name, snippet: p.snippet })),
        ];
        added = characters.length + els.length;
        return { ...d, characters: [...d.characters, ...characters], elements: [...(d.elements ?? []), ...els] };
      });
      toast(added ? `提取到 ${added} 个新设定` : '没有发现新的设定', added ? 'success' : 'info');
    } catch (error) {
      reportError(error);
    } finally {
      setLoading(false);
    }
  }

  async function addElement(kind: StoryElement['kind']) {
    const name = await promptDialog({ title: `新建${ELEMENT_META[kind].label}`, placeholder: kind === 'location' ? '例如：旧城区' : kind === 'prop' ? '例如：旧收音机' : '例如：水彩绘本', maxLength: 30, confirmText: '创建' });
    if (name) update((d) => ({ ...d, elements: [...(d.elements ?? []), newElement(kind, { name })] }));
  }

  const counts = { character: data.characters.length, location: elements.filter((e) => e.kind === 'location').length, prop: elements.filter((e) => e.kind === 'prop').length, style: elements.filter((e) => e.kind === 'style').length };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={section}
          onChange={setSection}
          options={[
            { value: 'character', label: `角色 ${counts.character || ''}` },
            { value: 'location', label: `地点 ${counts.location || ''}` },
            { value: 'prop', label: `道具 ${counts.prop || ''}` },
            { value: 'style', label: `画风 ${counts.style || ''}` },
          ]}
        />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" icon={<Sparkles className="size-3.5" />} loading={loading} onClick={() => void extract()}>
            从剧本提取
          </Button>
          {section === 'character' ? (
            <>
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => update((d) => ({ ...d, characters: [...d.characters, newCharacter()] }))}>
                添加角色
              </Button>
              <Button size="sm" variant="brand" icon={<Sparkles className="size-3.5" />} loading={loading} onClick={() => void generate()}>
                AI 生成角色
              </Button>
            </>
          ) : (
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => void addElement(section)}>
              添加{ELEMENT_META[section].label}
            </Button>
          )}
        </div>
      </div>
      <p className="mb-3 text-xs text-fg-3">{section === 'character' ? '角色的外貌、服装和定妆照会自动用于分镜生成，保持角色在不同镜头中一致。分镜描述里输入 @ 可以提及。' : ELEMENT_META[section].hint}</p>
      {section === 'character' ? (
        data.characters.length === 0 ? (
          <Empty icon={<UserRound className="size-6" />} title="还没有角色" hint="手动添加，或让 AI 根据大纲设计主要角色。" />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.characters.map((character) => (
              <CharacterCard key={character.id} character={character} onPick={() => setPicking(character.id)} inSeries={inSeries} />
            ))}
          </div>
        )
      ) : elements.filter((e) => e.kind === section).length === 0 ? (
        <Empty icon={(() => { const Icon = ELEMENT_META[section].icon; return <Icon className="size-6" />; })()} title={`还没有${ELEMENT_META[section].label}`} hint={ELEMENT_META[section].hint} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {elements
            .filter((e) => e.kind === section)
            .map((element) => (
              <ElementCard key={element.id} element={element} inSeries={inSeries} />
            ))}
        </div>
      )}
      <AssetPicker
        open={picking !== null}
        onClose={() => setPicking(null)}
        title="选择角色参考图"
        storyId={storyId}
        onPick={([asset]) => update((d) => ({ ...d, characters: d.characters.map((c) => (c.id === picking ? { ...c, referenceAssetId: asset.id } : c)) }))}
      />
    </div>
  );
}
