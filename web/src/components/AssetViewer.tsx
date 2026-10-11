// 大图 / 视频详情：左边看图，右边是完整的生成信息（提示词、参数、种子、算子、模板与预设、来源谱系）
// 和派生操作（再次生成、改参数重跑、变体、以此为参考、图转视频、保存提示词、对比、收藏、下载、删除）。
// 左右方向键 / 按钮切换同一列表里的上一个、下一个。
import { useEffect, useState } from 'react';
import {
  BookPlus,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Columns2,
  Copy,
  Download,
  GitBranch,
  Heart,
  ImagePlus,
  RotateCcw,
  Scissors,
  Save,
  Shuffle,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { TASK_TYPE_LABEL, type Asset } from '../../../shared/types.ts';
import { useCatalog } from '../pages/studio/create/catalog.ts';
import { useCompare, useDerive } from '../pages/studio/create/derive.ts';
import { api } from '../lib/api.ts';
import { reportError, useStore } from '../lib/store.ts';
import { cx, downloadUrl, timeAgo } from '../lib/util.ts';
import { AddToStoryDialog } from './AddToStoryDialog.tsx';
import { confirmDialog } from './ConfirmDialog.tsx';
import { Button, IconButton, Media, Modal, isVideoAsset } from './ui.tsx';

export function fileName(asset: Asset): string {
  const ext = asset.mime.split('/')[1]?.replace('svg+xml', 'svg') ?? 'bin';
  return `weave-${asset.id}.${ext}`;
}

/** 图转视频：先给 3 个动作建议（AI 不可用时用运镜预设兜底） */
export function MotionSheet({ asset, onClose }: { asset: Asset | null; onClose: () => void }) {
  const derive = useDerive();
  const [options, setOptions] = useState<{ level: string; prompt: string; camera?: string }[] | null>(null);
  useEffect(() => {
    if (!asset) return;
    setOptions(null);
    api
      .assist<{ motions: { level: string; prompt: string; camera: string }[] }>('motion', { prompt: asset.prompt ?? '' })
      .then((result) => setOptions(result.motions))
      .catch(() =>
        setOptions([
          { level: '轻微', prompt: '画面中的人物和物体轻微地动起来，光影缓慢变化', camera: '固定镜头' },
          { level: '中等', prompt: '主体自然地动起来，背景有流动感', camera: '缓慢推进' },
          { level: '戏剧性', prompt: '镜头围绕主体旋转，画面充满动感', camera: '环绕' },
        ]),
      );
  }, [asset]);
  return (
    <Modal open={Boolean(asset)} onClose={onClose} title="图转视频：选一个动作">
      {!options ? (
        <p className="py-6 text-center text-sm text-fg-3">正在想动作…</p>
      ) : (
        <ul className="space-y-2">
          {options.map((option) => (
            <li key={option.level}>
              <button
                className="w-full rounded-lg border border-line bg-white/[0.03] p-3 text-left hover:border-accent/60"
                onClick={() => {
                  derive.toVideo(asset!, option);
                  onClose();
                }}
              >
                <span className="text-xs text-accent">
                  {option.level}
                  {option.camera && ` · ${option.camera}`}
                </span>
                <p className="mt-1 text-sm">{option.prompt}</p>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button
        variant="ghost"
        className="mt-3"
        onClick={() => {
          derive.toVideo(asset!);
          onClose();
        }}
      >
        不用建议，自己写
      </Button>
    </Modal>
  );
}

function Lineage({ asset, onOpen }: { asset: Asset; onOpen: (asset: Asset) => void }) {
  const assets = useStore((s) => s.assets);
  const upsertAssets = useStore((s) => s.upsertAssets);
  const [chain, setChain] = useState<Asset[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const result: Asset[] = [];
      let id = asset.parentAssetId;
      for (let depth = 0; id && depth < 6; depth++) {
        const parent = useStore.getState().assets[id] ?? (await api.asset(id).catch(() => null));
        if (!parent) break;
        result.unshift(parent);
        id = parent.parentAssetId;
      }
      if (alive) {
        setChain(result);
        upsertAssets(result);
      }
    })();
    return () => {
      alive = false;
    };
  }, [asset, upsertAssets]);
  const children = Object.values(assets).filter((a) => a.parentAssetId === asset.id);
  if (!chain.length && !children.length) return null;
  return (
    <div>
      <p className="label flex items-center gap-1">
        <GitBranch className="size-3" /> 来源谱系
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {chain.map((item) => (
          <button key={item.id} onClick={() => onOpen(item)} className="size-12 overflow-hidden rounded-md border border-line" title="来源">
            <Media asset={item} />
          </button>
        ))}
        {chain.length > 0 && <ChevronRight className="size-3.5 text-fg-3" />}
        <span className="size-12 overflow-hidden rounded-md border-2 border-accent">
          <Media asset={asset} />
        </span>
        {children.length > 0 && <ChevronRight className="size-3.5 text-fg-3" />}
        {children.slice(0, 6).map((item) => (
          <button key={item.id} onClick={() => onOpen(item)} className="size-12 overflow-hidden rounded-md border border-line" title="派生">
            <Media asset={item} />
          </button>
        ))}
      </div>
    </div>
  );
}

export function AssetViewer({
  asset,
  onClose,
  onDeleted,
  list,
}: {
  asset: Asset | null;
  onClose: () => void;
  onDeleted?: (id: string) => void;
  /** 同一列表里的其他资产，用于左右切换 */
  list?: Asset[];
}) {
  const [current, setCurrent] = useState<Asset | null>(asset);
  const [motionFor, setMotionFor] = useState<Asset | null>(null);
  const [addTo, setAddTo] = useState<Asset | null>(null);
  const tasks = useStore((s) => s.tasks);
  const assets = useStore((s) => s.assets);
  const upsertAssets = useStore((s) => s.upsertAssets);
  const removeAsset = useStore((s) => s.removeAsset);
  const toast = useStore((s) => s.toast);
  const templates = useCatalog((s) => s.templates);
  const presetMap = useCatalog((s) => s.presetMap);
  const compare = useCompare();
  const derive = useDerive();

  useEffect(() => setCurrent(asset), [asset]);
  const live = current ? (assets[current.id] ?? current) : null;
  const index = live && list ? list.findIndex((a) => a.id === live.id) : -1;

  useEffect(() => {
    if (!live || !list) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.tagName === 'INPUT') return;
      if (event.key === 'ArrowLeft' && index > 0) setCurrent(list[index - 1]);
      if (event.key === 'ArrowRight' && index >= 0 && index < list.length - 1) setCurrent(list[index + 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [live, list, index]);

  if (!live) return null;
  const video = isVideoAsset(live);
  const task = live.taskId ? tasks[live.taskId] : null;
  const gen = live.gen;
  const template = templates.find((t) => t.id === (gen?.templateId ?? task?.recipe?.templateId));
  const presetNames = (gen?.presets ?? task?.recipe?.presets ?? []).map((slug) => presetMap.get(slug)?.name).filter(Boolean);
  const prompt = live.prompt ?? task?.prompt ?? '';

  async function toggleFavorite() {
    try {
      upsertAssets([await api.favorite(live!.id, !live!.favorite)]);
    } catch (error) {
      reportError(error);
    }
  }

  async function remove() {
    try {
      const usage = await api.assetUsage(live!.id);
      if (usage.activeTasks.length) {
        toast(`正在被任务「${usage.activeTasks[0].title}」使用，不能删除`, 'error');
        return;
      }
      const used = usage.stories.length ? `它正在被使用：${usage.stories.slice(0, 2).map((s) => `「${s.title}」${s.where}`).join('；')}。` : '';
      if (!(await confirmDialog({ title: '移入回收站？', message: `${used}30 天内可以在资产库的回收站里恢复。`, confirmText: '移入回收站', danger: Boolean(used) }))) return;
      await api.deleteAsset(live!.id);
      removeAsset(live!.id);
      onDeleted?.(live!.id);
      toast('已移入回收站', 'success');
      onClose();
    } catch (error) {
      reportError(error);
    }
  }

  async function grabFrame() {
    const video = document.querySelector<HTMLVideoElement>('[data-viewer-media] video');
    const at = video ? video.currentTime : 0;
    try {
      const frame = await api.frame(live!.id, at);
      upsertAssets([frame]);
      toast(`已把 ${at.toFixed(1)} 秒处的画面存为图片`, 'success');
    } catch (error) {
      reportError(error);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制${label}`, 'success');
    } catch {
      toast('浏览器不允许复制', 'error');
    }
  }

  const rows: [string, string][] = [
    ['类型', task ? TASK_TYPE_LABEL[task.type] : live.source === 'upload' ? '上传' : video ? '视频' : '图片'],
    ['尺寸', live.width && live.height ? `${live.width}×${live.height}${gen?.width && gen.width !== live.width ? `（提交 ${gen.width}×${gen.height}）` : ''}` : '—'],
    ...(live.duration ? ([['时长', `${live.duration} 秒`]] as [string, string][]) : []),
    ...(gen?.steps ? ([['步数', String(gen.steps)]] as [string, string][]) : []),
    ...(gen?.operator ? ([['算子', gen.operator]] as [string, string][]) : []),
    ...(template ? ([['模板', template.name]] as [string, string][]) : []),
    ...(presetNames.length ? ([['预设', presetNames.join('、')]] as [string, string][]) : []),
    ['时间', timeAgo(live.createdAt)],
  ];

  return (
    <Modal open onClose={onClose} wide bare>
      <div className="panel flex max-h-[94dvh] flex-col overflow-hidden rounded-b-none bg-ink-1 sm:rounded-xl lg:flex-row">
        <div data-viewer-media className="relative flex min-h-[40dvh] flex-1 items-center justify-center bg-black lg:min-h-[70dvh]">
          <Media asset={live} fit="contain" controls={video} autoPlay={video} className="max-h-[60dvh] lg:max-h-[86dvh]" />
          <IconButton label="关闭" onClick={onClose} className="glass absolute top-3 right-3">
            <X className="size-4" />
          </IconButton>
          {list && index > 0 && (
            <IconButton label="上一个" onClick={() => setCurrent(list[index - 1])} className="glass absolute top-1/2 left-3 -translate-y-1/2">
              <ChevronLeft className="size-4" />
            </IconButton>
          )}
          {list && index >= 0 && index < list.length - 1 && (
            <IconButton label="下一个" onClick={() => setCurrent(list[index + 1])} className="glass absolute top-1/2 right-3 -translate-y-1/2">
              <ChevronRight className="size-4" />
            </IconButton>
          )}
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto p-4 lg:w-[22rem] lg:p-5">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="label !mb-0">提示词</p>
              {prompt && (
                <button className="flex items-center gap-1 text-xs text-fg-3 hover:text-fg" onClick={() => void copy(prompt, '提示词')}>
                  <Copy className="size-3" /> 复制
                </button>
              )}
            </div>
            <p className="max-h-40 overflow-auto text-sm leading-relaxed text-fg-2">{prompt || (live.source === 'upload' ? '上传的素材' : '无提示词')}</p>
            {gen?.negativePrompt && <p className="mt-2 text-xs text-fg-3">反向：{gen.negativePrompt}</p>}
          </div>

          <dl className="divide-y divide-line text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3 py-1.5">
                <dt className="shrink-0 text-fg-3">{label}</dt>
                <dd className="truncate text-right">{value}</dd>
              </div>
            ))}
            {gen?.seed != null && (
              <div className="flex justify-between gap-3 py-1.5">
                <dt className="text-fg-3">种子</dt>
                <dd>
                  <button className="font-mono hover:text-accent" onClick={() => void copy(String(gen.seed), '种子')}>
                    {gen.seed}
                  </button>
                </dd>
              </div>
            )}
          </dl>

          <Lineage asset={live} onOpen={setCurrent} />

          {live.source === 'generated' && (
            <div className="grid grid-cols-2 gap-1.5">
              {task && (
                <Button size="sm" variant="secondary" icon={<RotateCcw className="size-3.5" />} onClick={() => void derive.rerun(task)}>
                  再次生成
                </Button>
              )}
              <Button size="sm" variant="secondary" icon={<SlidersHorizontal className="size-3.5" />} onClick={() => { derive.editRerun(task, live); onClose(); }}>
                改参数重跑
              </Button>
              {!video && (
                <>
                  <Button size="sm" variant="secondary" icon={<Shuffle className="size-3.5" />} onClick={() => void derive.variant(live, task)}>
                    变体
                  </Button>
                  <Button size="sm" variant="secondary" icon={<ImagePlus className="size-3.5" />} onClick={() => { derive.useAsReference(live); onClose(); }}>
                    以此为参考
                  </Button>
                  <Button size="sm" variant="secondary" icon={<Clapperboard className="size-3.5" />} className="col-span-2" onClick={() => setMotionFor(live)}>
                    图转视频
                  </Button>
                </>
              )}
            </div>
          )}
          {live.source === 'upload' && !video && (
            <div className="grid grid-cols-2 gap-1.5">
              <Button size="sm" variant="secondary" icon={<ImagePlus className="size-3.5" />} onClick={() => { derive.useAsReference(live); onClose(); }}>
                以此为参考
              </Button>
              <Button size="sm" variant="secondary" icon={<Clapperboard className="size-3.5" />} onClick={() => setMotionFor(live)}>
                图转视频
              </Button>
            </div>
          )}

          <div className="mt-auto flex flex-wrap gap-1 border-t border-line pt-3">
            <IconButton label={live.favorite ? '取消收藏' : '收藏'} onClick={() => void toggleFavorite()}>
              <Heart className={cx('size-4', live.favorite && 'fill-current text-danger')} />
            </IconButton>
            <IconButton label="下载" onClick={() => downloadUrl(`${live.url}?download=1`, live.filename ?? fileName(live))}>
              <Download className="size-4" />
            </IconButton>
            {video && (
              <IconButton label="把当前画面存为图片" onClick={() => void grabFrame()}>
                <Scissors className="size-4" />
              </IconButton>
            )}
            {prompt && (
              <IconButton label="保存提示词" onClick={() => void derive.savePrompt(prompt, video ? 'video' : 'image')}>
                <Save className="size-4" />
              </IconButton>
            )}
            {live.kind !== 'audio' && (
              <IconButton label="加入故事镜头" onClick={() => setAddTo(live)}>
                <BookPlus className="size-4" />
              </IconButton>
            )}
            <IconButton label={compare.ids.includes(live.id) ? '移出对比' : '加入对比'} onClick={() => compare.toggle(live.id)}>
              <Columns2 className={cx('size-4', compare.ids.includes(live.id) && 'text-accent')} />
            </IconButton>
            <span className="flex-1" />
            <IconButton label="移入回收站" onClick={() => void remove()}>
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        </aside>
      </div>
      <MotionSheet asset={motionFor} onClose={() => setMotionFor(null)} />
      <AddToStoryDialog asset={addTo} onClose={() => setAddTo(null)} />
    </Modal>
  );
}
