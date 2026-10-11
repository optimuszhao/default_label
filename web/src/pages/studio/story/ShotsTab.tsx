import { memo, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Columns2,
  Film,
  Image as ImageIcon,
  ImagePlus,
  Lock,
  LockOpen,
  Plus,
  SlidersHorizontal,
  Sparkles,
  ThumbsDown,
  Trash2,
  Wand2,
} from 'lucide-react';
import { maxDuration } from '../../../../../shared/operator.ts';
import { buildShotPrompt, findMentions, SEGMENT_LABEL, type PromptSegment } from '../../../../../shared/story-prompt.ts';
import type { Asset, Scene, Shot, StoryData, Task } from '../../../../../shared/types.ts';
import { AssetPicker } from '../../../components/AssetPicker.tsx';
import { Lightbox } from '../../../components/Lightbox.tsx';
import { Button, Empty, IconButton, Media, ProgressBar, Segmented } from '../../../components/ui.tsx';
import { api } from '../../../lib/api.ts';
import { CAMERA_MOVES, cssRatio, SHOT_SIZES } from '../../../lib/presets.ts';
import { reportError, useStore } from '../../../lib/store.ts';
import { cx } from '../../../lib/util.ts';
import { useCompare } from '../create/derive.ts';
import { useShotGenerator, useStory } from './context.tsx';
import { EMPTY_MEDIA, findScene, moveItem, newShot, updateScene, updateShot } from './model.ts';
import { SceneNavigator } from './SceneNavigator.tsx';
import { confirmDialog } from '../../../components/ConfirmDialog.tsx';

const ELEMENT_KIND_LABEL = { location: '地点', prop: '道具', style: '画风' } as const;

function MediaSlot({ label, asset, task, ratio, icon, onOpen }: { label: string; asset: Asset | null; task: Task | null; ratio: string; icon: React.ReactNode; onOpen: (asset: Asset) => void }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-ink-3" style={{ aspectRatio: cssRatio(ratio) }}>
      {asset ? (
        <button className="absolute inset-0" onClick={() => onOpen(asset)} aria-label={`查看${label}`}>
          <Media asset={asset} variant="thumb" />
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
            {task.status === 'running' ? `${task.stage ?? '生成中'} ${Math.round(task.progress * 100)}%` : task.waitReason ? '等待服务' : task.status === 'paused' ? '已暂停' : '排队中'}
          </span>
          <ProgressBar value={task.status === 'running' ? task.progress : 0} className="mt-1.5 w-2/3" />
        </div>
      )}
      <span className="pointer-events-none absolute top-1.5 left-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px]">{label}</span>
    </div>
  );
}

/** 画面描述：输入 @ 弹出角色和设定，选中后自动加为出镜 */
function MentionTextarea({ data, value, onChange }: { data: StoryData; value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const options = useMemo(() => {
    if (query === null) return [];
    const all = [...data.characters.map((c) => ({ id: c.id, name: c.name, kind: '角色' })), ...(data.elements ?? []).map((e) => ({ id: e.id, name: e.name, kind: ELEMENT_KIND_LABEL[e.kind] }))];
    return all.filter((item) => item.name.includes(query)).slice(0, 8);
  }, [query, data]);

  function detect(text: string, caret: number) {
    const before = text.slice(0, caret);
    const match = /@([^\s@，。、,.!！?？；;：:]*)$/.exec(before);
    setQuery(match ? match[1] : null);
  }

  function choose(name: string) {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = value.slice(0, caret).replace(/@([^\s@，。、,.!！?？；;：:]*)$/, `@${name} `);
    onChange(before + value.slice(caret));
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        className="field min-h-24 resize-y text-sm leading-relaxed"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          if (query !== null && options.length && (e.key === 'Enter' || e.key === 'Tab')) {
            e.preventDefault();
            choose(options[0].name);
          }
          if (e.key === 'Escape') setQuery(null);
        }}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
        placeholder="画面描述：主体、动作、环境、光线……输入 @ 提及角色或设定"
        aria-label="画面描述"
      />
      {query !== null && options.length > 0 && (
        <ul role="listbox" aria-label="提及角色或设定" className="glass absolute left-2 z-20 mt-1 max-h-48 w-56 overflow-auto rounded-lg border border-line-strong p-1 text-sm shadow-xl">
          {options.map((option) => (
            <li key={option.id}>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => choose(option.name)} className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-white/10">
                <span>{option.name}</span>
                <span className="text-xs text-fg-3">{option.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 最终提示词分段预览：每段标出来源，被截断的段单独提示 */
export function PromptPreview({ data, scene, shot }: { data: StoryData; scene: Scene; shot: Shot }) {
  const [purpose, setPurpose] = useState<'keyframe' | 'video'>('keyframe');
  const built = buildShotPrompt(data, scene, shot, { purpose });
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="label !mb-0">最终提示词（{built.prompt.length} 字）</p>
        <Segmented
          size="sm"
          value={purpose}
          onChange={setPurpose}
          options={[
            { value: 'keyframe', label: '关键帧' },
            { value: 'video', label: '视频' },
          ]}
        />
      </div>
      <p className="rounded-lg border border-line bg-white/[0.02] p-2 text-xs leading-relaxed">
        {built.segments.map((segment: PromptSegment, index) => (
          <span key={index} title={segment.label} className={cx('rounded px-0.5', index % 2 ? 'bg-accent/10' : 'bg-white/[0.06]')}>
            <sup className="mr-0.5 text-[9px] text-fg-3">{segment.label}</sup>
            {segment.text}
          </span>
        ))}
      </p>
      {built.dropped.length > 0 && <p className="text-[11px] text-warn">超过 600 字，已省略：{built.dropped.map((k) => SEGMENT_LABEL[k]).join('、')}</p>}
      <p className="text-[11px] text-fg-3">
        反向：{built.negative || '无'}
        {built.seed != null ? ` · 种子 ${built.seed}` : ''}
      </p>
    </div>
  );
}

const ShotCard = memo(function ShotCard({ scene, shot, index, onOpen }: { scene: Scene; shot: Shot; index: number; onOpen: (asset: Asset) => void }) {
  const { storyId, data, update, media } = useStory();
  const generator = useShotGenerator();
  const upsertAssets = useStore((s) => s.upsertAssets);
  const maxSeconds = maxDuration(useStore((s) => s.capabilities).video);
  const compare = useCompare();
  const [picking, setPicking] = useState<'keyframe' | 'first' | null>(null);
  const [inspect, setInspect] = useState(false);
  const m = media.get(shot.id) ?? EMPTY_MEDIA;
  const set = (patch: Partial<Shot>) => update(updateShot(scene.id, shot.id, patch));
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const elements = data.elements ?? [];
  const locked = Boolean(shot.locked);

  function changeDescription(value: string) {
    // @ 到的角色和设定自动加为出镜
    const found = findMentions(value, data);
    const characterIds = [...new Set([...shot.characterIds, ...found.characterIds])];
    const elementIds = [...new Set([...(shot.elementIds ?? []), ...found.elementIds])];
    set({ description: value, characterIds, ...(elementIds.length ? { elementIds } : {}) });
  }

  function lockToggle() {
    // 定稿时固定当前的选定画面
    set(locked ? { locked: false } : { locked: true, keyframeAssetId: shot.keyframeAssetId ?? m.keyframe?.id ?? null, videoAssetId: shot.videoAssetId ?? m.video?.id ?? null });
  }

  async function reject(asset: Asset) {
    try {
      upsertAssets([await api.patchAsset(asset.id, { flag: asset.flag === 'reject' ? null : 'reject' })]);
      if (asset.id === shot.keyframeAssetId) set({ keyframeAssetId: null });
      if (asset.id === shot.videoAssetId) set({ videoAssetId: null });
    } catch (error) {
      reportError(error);
    }
  }

  const prompting = shot.description.trim() || shot.promptOverride?.trim();

  return (
    <div className={cx('panel cv-auto overflow-hidden', locked && 'ring-1 ring-ok/40')}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 sm:px-4">
        <span className="font-mono text-sm font-semibold text-accent">#{shot.code || String(index + 1).padStart(2, '0')}</span>
        <select className="field !w-auto !py-1 !text-xs" value={shot.shotSize} onChange={(e) => set({ shotSize: e.target.value })} aria-label="景别" disabled={locked}>
          {SHOT_SIZES.map((size) => (
            <option key={size}>{size}</option>
          ))}
        </select>
        <select className="field !w-auto !py-1 !text-xs" value={shot.cameraMove} onChange={(e) => set({ cameraMove: e.target.value })} aria-label="运镜" disabled={locked}>
          {CAMERA_MOVES.map((move) => (
            <option key={move}>{move}</option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-fg-3">
          <input
            type="number"
            min={1}
            max={30}
            className="field !w-14 !px-2 !py-1 !text-xs"
            value={shot.duration}
            disabled={locked}
            onChange={(e) => set({ duration: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })}
            aria-label="时长（秒）"
          />
          秒
        </label>
        {shot.duration > maxSeconds && (
          <span className="text-xs text-warn" title={`生成服务单段视频最长 ${maxSeconds} 秒，生成时会截到 ${maxSeconds} 秒`}>
            超过 {maxSeconds} 秒，建议拆成两个镜头
          </span>
        )}
        <span className="ml-auto flex items-center">
          <button
            onClick={lockToggle}
            aria-pressed={locked}
            className={cx('mr-1 flex h-7 items-center gap-1 rounded-md px-2 text-xs transition', locked ? 'bg-ok/15 text-ok' : 'text-fg-3 hover:bg-white/[0.06] hover:text-fg')}
            title={locked ? '已定稿：批量操作不会改动这个镜头。点击取消定稿' : '定稿：固定当前选定的画面，批量操作不再改动'}
          >
            {locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
            {locked ? '已定稿' : '定稿'}
          </button>
          <IconButton label="检查器" className="size-7" active={inspect} onClick={() => setInspect((v) => !v)}>
            <SlidersHorizontal className="size-3.5" />
          </IconButton>
          <IconButton label="上移" className="size-7" onClick={() => update(updateScene(scene.id, (s) => ({ ...s, shots: moveItem(s.shots, index, -1) })))}>
            <ChevronUp className="size-3.5" />
          </IconButton>
          <IconButton label="下移" className="size-7" onClick={() => update(updateScene(scene.id, (s) => ({ ...s, shots: moveItem(s.shots, index, 1) })))}>
            <ChevronDown className="size-3.5" />
          </IconButton>
          <IconButton label="删除镜头" className="size-7 hover:text-danger" onClick={() => update(updateScene(scene.id, (s) => ({ ...s, shots: s.shots.filter((x) => x.id !== shot.id) })))}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </span>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 p-3 sm:p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-3">
          <MentionTextarea data={data} value={shot.description} onChange={changeDescription} />
          {(data.characters.length > 0 || elements.length > 0) && (
            <div>
              <p className="label">出镜</p>
              <div className="flex flex-wrap gap-1">
                {data.characters.map((c) => (
                  <button key={c.id} className="chip !h-6 !px-2 !text-[11px]" data-active={shot.characterIds.includes(c.id)} onClick={() => set({ characterIds: toggle(shot.characterIds, c.id) })}>
                    {c.name}
                  </button>
                ))}
                {elements.map((e) => (
                  <button
                    key={e.id}
                    className="chip !h-6 !px-2 !text-[11px]"
                    data-active={(shot.elementIds ?? []).includes(e.id)}
                    onClick={() => set({ elementIds: toggle(shot.elementIds ?? [], e.id) })}
                    title={ELEMENT_KIND_LABEL[e.kind]}
                  >
                    <span className="text-fg-3">{ELEMENT_KIND_LABEL[e.kind]}·</span>
                    {e.name}
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
                      className={cx('shrink-0 truncate rounded-lg border px-2 py-1 text-left text-xs transition', on ? 'border-violet/50 bg-violet/10 text-fg' : 'border-transparent text-fg-3 hover:bg-white/[0.04]')}
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
              <Button size="sm" className="flex-1" icon={<Wand2 className="size-3.5" />} disabled={!prompting || Boolean(m.keyframeTask)} onClick={() => void generator.keyframe(scene, shot)}>
                {m.keyframe ? '再出一张' : '生成'}
              </Button>
              <IconButton label="选择已有图片作为关键帧" onClick={() => setPicking('keyframe')} className="border border-line">
                <ImagePlus className="size-4" />
              </IconButton>
            </div>
            <Button size="sm" variant={m.keyframe ? 'brand' : 'secondary'} icon={<Clapperboard className="size-3.5" />} disabled={!prompting || Boolean(m.videoTask)} onClick={() => void generator.video(scene, shot)}>
              {shot.firstFrame?.mode === 'prev_last' ? '接续上一镜' : m.keyframe || shot.firstFrame?.mode === 'asset' ? '图生视频' : '文生视频'}
            </Button>
          </div>
          {m.keyframes.length + m.videos.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] text-fg-3">候选（点击选定；{locked ? '已定稿，新候选不会替换' : '定稿后批量操作不会改动'}）</p>
              <div className="no-scrollbar flex gap-1.5 overflow-x-auto pb-1">
                {[...m.keyframes, ...m.videos].map((asset) => {
                  const selected = asset.id === m.keyframe?.id || asset.id === m.video?.id;
                  const rejected = asset.flag === 'reject';
                  return (
                    <div key={asset.id} className="group relative h-12 shrink-0" style={{ aspectRatio: cssRatio(data.aspectRatio) }}>
                      <button
                        title={asset.purpose === 'video' ? '设为本镜视频' : '设为本镜关键帧'}
                        onClick={() => set(asset.purpose === 'video' ? { videoAssetId: asset.id } : { keyframeAssetId: asset.id })}
                        className={cx('absolute inset-0 overflow-hidden rounded-md border-2', selected ? 'border-violet' : 'border-transparent', rejected ? 'opacity-30' : 'opacity-80 hover:opacity-100')}
                      >
                        <Media asset={asset} variant="thumb" />
                        {asset.purpose === 'video' && <Film className="absolute right-0.5 bottom-0.5 size-2.5" />}
                      </button>
                      <span className="absolute -top-1 -right-1 hidden gap-0.5 group-hover:flex">
                        <button title={rejected ? '取消淘汰' : '淘汰'} onClick={() => void reject(asset)} className="rounded bg-black/80 p-0.5 text-fg-2 hover:text-danger">
                          <ThumbsDown className="size-3" />
                        </button>
                        <button title="加入对比" onClick={() => compare.toggle(asset.id)} className={cx('rounded bg-black/80 p-0.5 hover:text-accent', compare.ids.includes(asset.id) ? 'text-accent' : 'text-fg-2')}>
                          <Columns2 className="size-3" />
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {inspect && (
        <div className="grid gap-4 border-t border-line bg-white/[0.015] p-3 sm:p-4 md:grid-cols-2">
          <div className="space-y-3">
            <div>
              <p className="label">视频首帧</p>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  size="sm"
                  value={shot.firstFrame?.mode ?? 'keyframe'}
                  onChange={(mode) => (mode === 'asset' ? setPicking('first') : set({ firstFrame: { mode } }))}
                  options={[
                    { value: 'keyframe', label: '选定的关键帧' },
                    { value: 'prev_last', label: '接续上一镜尾帧' },
                    { value: 'asset', label: '指定素材' },
                  ]}
                />
                {shot.firstFrame?.mode === 'asset' && shot.firstFrame.assetId && (
                  <button className="text-xs text-accent hover:underline" onClick={() => setPicking('first')}>
                    更换
                  </button>
                )}
              </div>
            </div>
            <div>
              <p className="label">种子</p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  className="field !w-36 !py-1 text-xs"
                  value={shot.seed ?? ''}
                  placeholder="随机"
                  onChange={(e) => set({ seed: e.target.value === '' ? null : Math.trunc(Number(e.target.value)) })}
                  aria-label="锁定种子"
                />
                {m.keyframe?.gen?.seed != null && shot.seed !== m.keyframe.gen.seed && (
                  <button className="text-xs text-accent hover:underline" onClick={() => set({ seed: m.keyframe!.gen!.seed })}>
                    锁定当前关键帧的种子
                  </button>
                )}
              </div>
            </div>
            <div>
              <p className="label">追加内容</p>
              <input className="field !py-1.5 text-xs" value={shot.extraPrompt ?? ''} onChange={(e) => set({ extraPrompt: e.target.value })} placeholder="拼在自动提示词后面，例如：逆光，雨滴特写" />
            </div>
            <div>
              <p className="label">这个镜头额外避免</p>
              <input className="field !py-1.5 text-xs" value={shot.negative ?? ''} onChange={(e) => set({ negative: e.target.value })} placeholder="例如：多余的人物" />
            </div>
            <div>
              <p className="label">手写提示词（填了就不再自动拼）</p>
              <textarea className="field min-h-16 text-xs" value={shot.promptOverride ?? ''} onChange={(e) => set({ promptOverride: e.target.value })} />
            </div>
          </div>
          <PromptPreview data={data} scene={scene} shot={shot} />
        </div>
      )}

      <AssetPicker
        open={picking !== null}
        onClose={() => setPicking(null)}
        title={picking === 'first' ? '选择视频首帧' : '选择关键帧'}
        storyId={storyId}
        onPick={([asset]) => {
          upsertAssets([asset]);
          if (picking === 'first') set({ firstFrame: { mode: 'asset', assetId: asset.id } });
          // 选中的已有图片直接作为本镜关键帧，后续图生视频以它为首帧
          else set({ keyframeAssetId: asset.id });
        }}
      />
    </div>
  );
});

export function ShotsTab() {
  const { storyId, data, update, sceneId, flushNow } = useStory();
  const generator = useShotGenerator();
  const compare = useCompare();
  const [designing, setDesigning] = useState(false);
  const [viewing, setViewing] = useState<Asset | null>(null);
  const found = findScene(data, sceneId);

  async function design() {
    if (!found) return;
    const { scene } = found;
    if (scene.shots.length && !(await confirmDialog({ title: '用 AI 设计的分镜替换本场现有镜头？', message: '当前内容会先存进历史版本。已定稿的镜头会保留。' }))) return;
    setDesigning(true);
    try {
      await flushNow?.();
      const result = await api.assist<{
        shots: { shotSize: string; cameraMove: string; description: string; duration: number; dialogueIndexes: number[]; characterNames: string[] }[];
      }>('shots', {
        storyId,
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
      // 已定稿的镜头保留在原位置前面
      update(updateScene(scene.id, (s) => ({ ...s, shots: [...s.shots.filter((x) => x.locked), ...shots] })));
    } catch (error) {
      reportError(error);
    } finally {
      setDesigning(false);
    }
  }

  const items = found ? found.scene.shots : [];
  const total = items.reduce((sum, shot) => sum + shot.duration, 0);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <div className="lg:sticky lg:top-28 lg:self-start">
        <SceneNavigator />
      </div>
      {!found ? (
        <Empty icon={<Clapperboard className="size-6" />} title="选择一个场次" hint="分镜按场次组织。先在「章节场次」中创建场次，再回来设计镜头。" />
      ) : (
        <div className="space-y-3">
          <div className="panel flex flex-wrap items-center justify-between gap-3 p-3 sm:p-4">
            <div className="min-w-0">
              <p className="truncate font-medium">{found.scene.title}</p>
              <p className="text-xs text-fg-3">
                {found.chapter.title} · {items.length} 个镜头 · {total} 秒 · 定稿 {items.filter((s) => s.locked).length}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {compare.ids.length > 0 && (
                <Button size="sm" variant="ghost" icon={<Columns2 className="size-3.5" />} onClick={() => compare.setOpen(true)}>
                  对比（{compare.ids.length}）
                </Button>
              )}
              <Button size="sm" variant="brand" icon={<Sparkles className="size-3.5" />} loading={designing} onClick={() => void design()}>
                AI 设计分镜
              </Button>
              <Button size="sm" icon={<ImageIcon className="size-3.5" />} disabled={!items.length} onClick={() => generator.batch({ type: 'scene', id: found.scene.id, label: found.scene.title }, 'keyframe')}>
                批量生成…
              </Button>
            </div>
          </div>

          {found.scene.shots.map((shot, index) => (
            <ShotCard key={shot.id} scene={found.scene} shot={shot} index={index} onOpen={setViewing} />
          ))}

          <button
            onClick={() => update(updateScene(found.scene.id, (s) => ({ ...s, shots: [...s.shots, newShot()] })))}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line py-4 text-sm text-fg-3 transition hover:border-line-strong hover:text-fg"
          >
            <Plus className="size-4" /> 添加镜头
          </button>
        </div>
      )}
      <Lightbox asset={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
