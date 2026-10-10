import { useEffect, useState } from 'react';
import { ImagePlus, Plus, Sparkles, Trash2, UserRound, Wand2 } from 'lucide-react';
import type { Character } from '../../../../../shared/types.ts';
import { AssetPicker } from '../../../components/AssetPicker.tsx';
import { Button, Empty, IconButton, Media, ProgressBar } from '../../../components/ui.tsx';
import { api } from '../../../lib/api.ts';
import { imageParams } from '../../../lib/presets.ts';
import { reportError, useStore } from '../../../lib/store.ts';
import { cx } from '../../../lib/util.ts';
import { useStory } from './context.tsx';
import { newCharacter } from './model.ts';

const ROLES = ['主角', '配角', '反派', '群演'];

function CharacterCard({ character, onPick }: { character: Character; onPick: () => void }) {
  const { storyId, data, update } = useStory();
  const assets = useStore((s) => s.assets);
  const tasks = useStore((s) => s.tasks);
  const upsertTasks = useStore((s) => s.upsertTasks);
  const shotKey = `char_${character.id}`;
  const portraits = Object.values(assets)
    .filter((a) => a.storyId === storyId && a.shotId === shotKey)
    .sort((a, b) => b.createdAt - a.createdAt);
  const active = Object.values(tasks).find(
    (t) => t.link.shotId === shotKey && ['queued', 'running', 'paused'].includes(t.status),
  );
  const reference = character.referenceAssetId ? assets[character.referenceAssetId] : null;
  const set = (patch: Partial<Character>) =>
    update((d) => ({ ...d, characters: d.characters.map((c) => (c.id === character.id ? { ...c, ...patch } : c)) }));

  // 第一张定妆照生成后自动设为角色参考图
  useEffect(() => {
    if (!character.referenceAssetId && portraits[0]) set({ referenceAssetId: portraits[0].id });
  }, [portraits[0]?.id]);

  async function generatePortrait() {
    if (!character.appearance.trim()) {
      useStore.getState().toast('先填写角色外貌描述', 'info');
      return;
    }
    try {
      const task = await api.createTask({
        type: 't2i',
        title: `定妆照 · ${character.name}`,
        prompt: `${data.visualStyle}。角色定妆照，半身像，纯色背景，正面，清晰面部特征。${character.name}：${character.appearance}`,
        negativePrompt: '多人，模糊，畸形，文字水印',
        params: imageParams('3:4', '1k'),
        link: { storyId, shotId: shotKey, purpose: 'keyframe' },
        runNow: true,
      });
      upsertTasks([task]);
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <div className="panel flex flex-col overflow-hidden">
      <div className="flex gap-3 p-4">
        <div className="relative aspect-[3/4] w-24 shrink-0 overflow-hidden rounded-xl bg-ink-3 sm:w-28">
          {reference ? (
            <Media asset={reference} />
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
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <input className="field !py-1.5 font-medium" value={character.name} onChange={(e) => set({ name: e.target.value })} aria-label="角色名" />
            <IconButton
              label="删除角色"
              className="hover:text-danger"
              onClick={() => confirm(`删除角色「${character.name}」？`) && update((d) => ({ ...d, characters: d.characters.filter((c) => c.id !== character.id) }))}
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
            <Button size="sm" icon={<Wand2 className="size-3.5" />} onClick={() => void generatePortrait()} disabled={Boolean(active)}>
              生成定妆照
            </Button>
            <Button size="sm" variant="ghost" icon={<ImagePlus className="size-3.5" />} onClick={onPick}>
              选择
            </Button>
          </div>
        </div>
      </div>
      <div className="space-y-2 px-4 pb-4">
        <div>
          <label className="label">外貌（用于生成，保持角色一致）</label>
          <textarea className="field resize-none text-sm" rows={3} value={character.appearance} onChange={(e) => set({ appearance: e.target.value })} placeholder="年龄、发型、服装、体态、标志性特征" />
        </div>
        <div>
          <label className="label">性格 / 小传</label>
          <textarea className="field resize-none text-sm" rows={2} value={character.personality} onChange={(e) => set({ personality: e.target.value })} />
        </div>
        {portraits.length > 1 && (
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto pt-1">
            {portraits.map((asset) => (
              <button
                key={asset.id}
                onClick={() => set({ referenceAssetId: asset.id })}
                className={cx('aspect-[3/4] w-10 shrink-0 overflow-hidden rounded-md border-2', character.referenceAssetId === asset.id ? 'border-violet' : 'border-transparent')}
              >
                <Media asset={asset} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function CharactersTab() {
  const { data, update } = useStory();
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);

  async function generate() {
    if (!data.outline.trim() && !data.logline.trim()) {
      useStore.getState().toast('先在「设定与大纲」里写好故事大纲', 'info');
      return;
    }
    setLoading(true);
    try {
      const result = await api.assist<{ characters: Omit<Character, 'id' | 'referenceAssetId'>[] }>('characters', {
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

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-3">角色的外貌描述和定妆照会自动用于分镜生成，保持角色在不同镜头中一致。</p>
        <div className="flex gap-2">
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => update((d) => ({ ...d, characters: [...d.characters, newCharacter()] }))}>
            添加角色
          </Button>
          <Button size="sm" variant="brand" icon={<Sparkles className="size-3.5" />} loading={loading} onClick={() => void generate()}>
            AI 生成角色
          </Button>
        </div>
      </div>
      {data.characters.length === 0 ? (
        <Empty icon={<UserRound className="size-6" />} title="还没有角色" hint="手动添加，或让 AI 根据大纲设计主要角色。" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.characters.map((character) => (
            <CharacterCard key={character.id} character={character} onPick={() => setPicking(character.id)} />
          ))}
        </div>
      )}
      <AssetPicker
        open={picking !== null}
        onClose={() => setPicking(null)}
        title="选择角色参考图"
        onPick={([asset]) =>
          update((d) => ({ ...d, characters: d.characters.map((c) => (c.id === picking ? { ...c, referenceAssetId: asset.id } : c)) }))
        }
      />
    </div>
  );
}
