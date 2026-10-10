import { memo, useState } from 'react';
import { ChevronDown, ChevronUp, Clapperboard, Film, Image as ImageIcon, ImagePlus, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react';
import type { Asset, Scene, Shot, Task } from '../../../../../shared/types.ts';
import { AssetPicker } from '../../../components/AssetPicker.tsx';
import { Lightbox } from '../../../components/Lightbox.tsx';
import { Button, Empty, IconButton, Media, ProgressBar } from '../../../components/ui.tsx';
import { api } from '../../../lib/api.ts';
import { CAMERA_MOVES, cssRatio, SHOT_SIZES } from '../../../lib/presets.ts';
import { reportError, useStore } from '../../../lib/store.ts';
import { cx } from '../../../lib/util.ts';
import { useShotGenerator, useStory } from './context.tsx';
import { EMPTY_MEDIA, findScene, moveItem, newShot, updateScene, updateShot } from './model.ts';
import { SceneNavigator } from './SceneNavigator.tsx';

function MediaSlot({
  label,
  asset,
  task,
  ratio,
  icon,
  onOpen,
}: {
  label: string;
  asset: Asset | null;
  task: Task | null;
  ratio: string;
  icon: React.ReactNode;
  onOpen: (asset: Asset) => void;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-ink-3" style={{ aspectRatio: cssRatio(ratio) }}>
      {asset ? (
        <button className="absolute inset-0" onClick={() => onOpen(asset)} aria-label={`查看${label}`}>
          <Media asset={asset} />
        </button>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-fg-3">
          {icon}
          <span className="text-[11px]">{label}</span>
        </div>
      )}
      {task && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/55 px-3 backdrop-blur-[2px]">
          <span className="text-[11px] text-fg-2">
            {task.status === 'running' ? `生成中 ${Math.round(task.progress * 100)}%` : task.waitReason ? '等待服务' : task.status === 'paused' ? '已暂停' : '排队中'}
          </span>
          <ProgressBar value={task.status === 'running' ? task.progress : 0} className="mt-1.5 w-2/3" />
        </div>
      )}
      <span className="pointer-events-none absolute top-1.5 left-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px]">{label}</span>
    </div>
  );
}

const ShotCard = memo(function ShotCard({
  scene,
  shot,
  index,
  onOpen,
}: {
  scene: Scene;
  shot: Shot;
  index: number;
  onOpen: (asset: Asset) => void;
}) {
  const { data, update, media } = useStory();
  const generator = useShotGenerator();
  const upsertAssets = useStore((s) => s.upsertAssets);
  const [picking, setPicking] = useState(false);
  const m = media.get(shot.id) ?? EMPTY_MEDIA;
  const set = (patch: Partial<Shot>) => update(updateShot(scene.id, shot.id, patch));
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <div className="panel cv-auto overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 sm:px-4">
        <span className="font-mono text-sm font-semibold text-gradient">#{String(index + 1).padStart(2, '0')}</span>
        <select className="field !w-auto !py-1 !text-xs" value={shot.shotSize} onChange={(e) => set({ shotSize: e.target.value })} aria-label="景别">
          {SHOT_SIZES.map((size) => <option key={size}>{size}</option>)}
        </select>
        <select className="field !w-auto !py-1 !text-xs" value={shot.cameraMove} onChange={(e) => set({ cameraMove: e.target.value })} aria-label="运镜">
          {CAMERA_MOVES.map((move) => <option key={move}>{move}</option>)}
        </select>
        <label className="flex items-center gap-1 text-xs text-fg-3">
          <input
            type="number"
            min={1}
            max={30}
            className="field !w-14 !px-2 !py-1 !text-xs"
            value={shot.duration}
            onChange={(e) => set({ duration: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })}
            aria-label="时长（秒）"
          />
          秒
        </label>
        <span className="ml-auto flex">
          <IconButton label="上移" className="size-7" onClick={() => update(updateScene(scene.id, (s) => ({ ...s, shots: moveItem(s.shots, index, -1) })))}><ChevronUp className="size-3.5" /></IconButton>
          <IconButton label="下移" className="size-7" onClick={() => update(updateScene(scene.id, (s) => ({ ...s, shots: moveItem(s.shots, index, 1) })))}><ChevronDown className="size-3.5" /></IconButton>
          <IconButton label="删除镜头" className="size-7 hover:text-danger" onClick={() => update(updateScene(scene.id, (s) => ({ ...s, shots: s.shots.filter((x) => x.id !== shot.id) })))}><Trash2 className="size-3.5" /></IconButton>
        </span>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 p-3 sm:p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-3">
          <textarea
            className="field min-h-24 resize-y text-sm leading-relaxed"
            value={shot.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="画面描述：主体、动作、环境、光线……"
            aria-label="画面描述"
          />
          {data.characters.length > 0 && (
            <div>
              <p className="label">出镜角色</p>
              <div className="flex flex-wrap gap-1">
                {data.characters.map((c) => (
                  <button key={c.id} className="chip !h-6 !px-2 !text-[11px]" data-active={shot.characterIds.includes(c.id)} onClick={() => set({ characterIds: toggle(shot.characterIds, c.id) })}>
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {scene.dialogue.length > 0 && (
            <div>
              <p className="label">对应台词</p>
              <div className="flex max-h-28 flex-col gap-1 overflow-auto">
                {scene.dialogue.map((line) => {
                  const on = shot.dialogueIds.includes(line.id);
                  return (
                    <button
                      key={line.id}
                      onClick={() => set({ dialogueIds: toggle(shot.dialogueIds, line.id) })}
                      className={cx(
                        'shrink-0 truncate rounded-lg border px-2 py-1 text-left text-xs transition',
                        on ? 'border-violet/50 bg-violet/10 text-fg' : 'border-transparent text-fg-3 hover:bg-white/[0.04]',
                      )}
                    >
                      <span className="text-fg-2">{data.characters.find((c) => c.id === line.characterId)?.name ?? '旁白'}：</span>
                      {line.text || '（空）'}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <MediaSlot label="关键帧" asset={m.keyframe} task={m.keyframeTask} ratio={data.aspectRatio} icon={<ImageIcon className="size-5" />} onOpen={onOpen} />
            <MediaSlot label="视频" asset={m.video} task={m.videoTask} ratio={data.aspectRatio} icon={<Film className="size-5" />} onOpen={onOpen} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-wrap gap-1">
              <Button size="sm" className="flex-1" icon={<Wand2 className="size-3.5" />} disabled={!shot.description.trim() || Boolean(m.keyframeTask)} onClick={() => void generator.keyframe(scene, shot)}>
                {m.keyframe ? '重画' : '生成'}
              </Button>
              <IconButton label="选择已有图片作为关键帧" onClick={() => setPicking(true)} className="border border-line">
                <ImagePlus className="size-4" />
              </IconButton>
            </div>
            <Button size="sm" variant={m.keyframe ? 'brand' : 'secondary'} icon={<Clapperboard className="size-3.5" />} disabled={!shot.description.trim() || Boolean(m.videoTask)} onClick={() => void generator.video(scene, shot)}>
              {m.keyframe ? '图生视频' : '文生视频'}
            </Button>
          </div>
          {(m.keyframes.length > 1 || m.videos.length > 1) && (
            <div className="no-scrollbar flex gap-1.5 overflow-x-auto pt-1">
              {[...m.keyframes, ...m.videos].map((asset) => {
                const selected = asset.id === m.keyframe?.id || asset.id === m.video?.id;
                return (
                  <button
                    key={asset.id}
                    title={asset.purpose === 'video' ? '设为本镜视频' : '设为本镜关键帧'}
                    onClick={() => set(asset.purpose === 'video' ? { videoAssetId: asset.id } : { keyframeAssetId: asset.id })}
                    className={cx('relative h-10 shrink-0 overflow-hidden rounded-md border-2', selected ? 'border-violet' : 'border-transparent opacity-70 hover:opacity-100')}
                    style={{ aspectRatio: cssRatio(data.aspectRatio) }}
                  >
                    <Media asset={asset} />
                    {asset.purpose === 'video' && <Film className="absolute right-0.5 bottom-0.5 size-2.5" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <AssetPicker
        open={picking}
        onClose={() => setPicking(false)}
        title="选择关键帧"
        onPick={([asset]) => {
          // 选中的已有图片直接作为本镜关键帧，后续图生视频以它为首帧
          upsertAssets([asset]);
          set({ keyframeAssetId: asset.id });
        }}
      />
    </div>
  );
});

export function ShotsTab() {
  const { data, update, sceneId } = useStory();
  const generator = useShotGenerator();
  const [designing, setDesigning] = useState(false);
  const [viewing, setViewing] = useState<Asset | null>(null);
  const found = findScene(data, sceneId);

  async function design() {
    if (!found) return;
    const { scene } = found;
    if (scene.shots.length && !confirm('用 AI 设计的分镜替换本场现有镜头？')) return;
    setDesigning(true);
    try {
      const result = await api.assist<{
        shots: { shotSize: string; cameraMove: string; description: string; duration: number; dialogueIndexes: number[]; characterNames: string[] }[];
      }>('shots', {
        visualStyle: data.visualStyle,
        sceneTitle: scene.title,
        location: scene.location,
        time: scene.time,
        sceneSummary: scene.summary,
        dialogue: scene.dialogue.map((d) => ({ character: data.characters.find((c) => c.id === d.characterId)?.name ?? '旁白', text: d.text })),
        characterNames: data.characters.map((c) => c.name),
        characters: data.characters.map((c) => ({ name: c.name, appearance: c.appearance })),
      });
      const shots = result.shots.map((s) =>
        newShot({
          shotSize: s.shotSize || '中景',
          cameraMove: s.cameraMove || '固定',
          description: s.description,
          duration: Math.max(1, Math.min(30, Number(s.duration) || 5)),
          dialogueIds: (s.dialogueIndexes ?? []).map((i) => scene.dialogue[i]?.id).filter((id): id is string => Boolean(id)),
          characterIds: (s.characterNames ?? []).map((name) => data.characters.find((c) => c.name === name)?.id).filter((id): id is string => Boolean(id)),
        }),
      );
      update(updateScene(scene.id, (s) => ({ ...s, shots })));
    } catch (error) {
      reportError(error);
    } finally {
      setDesigning(false);
    }
  }

  const items = found ? found.scene.shots.map((shot) => ({ scene: found.scene, shot })) : [];
  const total = items.reduce((sum, { shot }) => sum + shot.duration, 0);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="lg:sticky lg:top-6 lg:self-start">
        <SceneNavigator />
      </div>
      {!found ? (
        <Empty icon={<Clapperboard className="size-6" />} title="选择一个场次" hint="分镜按场次组织。先在「章节剧本」中创建场次，再回来设计镜头。" />
      ) : (
        <div className="space-y-3">
          <div className="panel flex flex-wrap items-center justify-between gap-3 p-3 sm:p-4">
            <div className="min-w-0">
              <p className="truncate font-medium">{found.scene.title}</p>
              <p className="text-xs text-fg-3">
                {found.chapter.title} · {items.length} 个镜头 · {total} 秒
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="brand" icon={<Sparkles className="size-3.5" />} loading={designing} onClick={() => void design()}>
                AI 设计分镜
              </Button>
              <Button size="sm" icon={<ImageIcon className="size-3.5" />} disabled={!items.length} onClick={() => void generator.batchKeyframes(items)}>
                全部关键帧
              </Button>
              <Button size="sm" icon={<Film className="size-3.5" />} disabled={!items.length} onClick={() => void generator.batchVideos(items)}>
                全部视频
              </Button>
            </div>
          </div>

          {found.scene.shots.map((shot, index) => (
            <ShotCard key={shot.id} scene={found.scene} shot={shot} index={index} onOpen={setViewing} />
          ))}

          <button
            onClick={() => update(updateScene(found.scene.id, (s) => ({ ...s, shots: [...s.shots, newShot()] })))}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line py-4 text-sm text-fg-3 transition hover:border-line-strong hover:text-fg"
          >
            <Plus className="size-4" /> 添加镜头
          </button>
        </div>
      )}
      <Lightbox asset={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
