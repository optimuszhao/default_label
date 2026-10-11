// 派生操作：再次生成、改参数重跑、变体、以此为参考、图转视频、保存提示词、加入对比
import { useNavigate } from 'react-router-dom';
import { create } from 'zustand';
import { emptyRecipe } from '../../../../../shared/compose.ts';
import type { Recipe } from '../../../../../shared/presets.ts';
import type { Asset, Task } from '../../../../../shared/types.ts';
import { api } from '../../../lib/api.ts';
import { reportError, useStore } from '../../../lib/store.ts';
import { useCatalog } from './catalog.ts';

/** 任务的配方；老任务没有配方时按提示词和参数还原一个 */
export function recipeOf(task: Task | null | undefined, asset?: Asset | null): Recipe {
  if (task?.recipe) return structuredClone(task.recipe);
  const video = task ? task.type === 't2v' || task.type === 'i2v' : asset?.kind === 'video';
  return {
    ...emptyRecipe(video ? 'video' : 'image'),
    text: task?.prompt ?? asset?.prompt ?? '',
    negative: task?.negativePrompt ?? '',
    overrides: task
      ? { aspectRatio: task.params.aspectRatio, count: task.params.count, duration: task.params.duration, steps: task.params.steps }
      : {},
  };
}

/** 对比选择（最多 4 个） */
export const useCompare = create<{ ids: string[]; open: boolean; toggle: (id: string) => void; clear: () => void; setOpen: (open: boolean) => void }>((set, get) => ({
  ids: [],
  open: false,
  toggle: (id) => {
    const ids = get().ids;
    if (ids.includes(id)) set({ ids: ids.filter((x) => x !== id) });
    else if (ids.length >= 4) useStore.getState().toast('最多对比 4 个', 'info');
    else set({ ids: [...ids, id] });
  },
  clear: () => set({ ids: [], open: false }),
  setOpen: (open) => set({ open }),
}));

export function useDerive() {
  const navigate = useNavigate();
  const setDraft = useStore((s) => s.setComposerDraft);
  const upsertTasks = useStore((s) => s.upsertTasks);
  const toast = useStore((s) => s.toast);
  const caps = useStore((s) => s.capabilities);

  const goCreate = () => {
    navigate('/studio/create');
    requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
  };

  return {
    /** 同配方换一个种子再来一次 */
    rerun: async (task: Task) => {
      try {
        upsertTasks([await api.taskAction(task.id, 'retry')]);
        toast('已重新提交', 'success');
      } catch (error) {
        reportError(error);
      }
    },

    /** 把配方（含这张图的种子）载入创作台，改完再生成 */
    editRerun: (task: Task | null | undefined, asset?: Asset | null) => {
      const recipe = recipeOf(task, asset);
      const seed = asset?.gen?.seed ?? task?.params.seed ?? null;
      setDraft({
        mode: recipe.mode,
        recipe: { ...recipe, overrides: { ...recipe.overrides, seed } },
        referenceAssetIds: task?.inputs.referenceAssetIds,
        firstFrameAssetId: task?.inputs.firstFrameAssetId ?? null,
      });
      toast(seed != null ? `已载入配方，种子 ${seed} 已锁定` : '已载入配方', 'info');
      goCreate();
    },

    /** 变体：以这张图为参考、同样的配方，换种子出新的一组 */
    variant: async (asset: Asset, task?: Task | null) => {
      if (caps.image.maxReferences < 1) {
        if (task) {
          upsertTasks([await api.taskAction(task.id, 'retry')]);
          toast('当前算子不支持图生图，已用同样的配方换种子重新生成', 'info');
        }
        return;
      }
      const recipe = recipeOf(task, asset);
      try {
        const created = await api.createTask({
          type: 'i2i',
          prompt: '',
          params: { aspectRatio: recipe.overrides.aspectRatio ?? '1:1', resolution: '1k', width: asset.width ?? 1024, height: asset.height ?? 1024, count: 1, seed: null },
          inputs: { referenceAssetIds: [asset.id] },
          recipe: { ...recipe, mode: 'image', overrides: { ...recipe.overrides, seed: null }, parentAssetId: asset.id },
          runNow: true,
        });
        upsertTasks([created]);
        toast('已提交变体', 'success');
      } catch (error) {
        reportError(error);
      }
    },

    /** 以此为参考：载入创作台的图生图 */
    useAsReference: (asset: Asset) => {
      setDraft({ mode: 'image', recipe: { ...emptyRecipe('image'), parentAssetId: asset.id }, referenceAssetIds: [asset.id] });
      goCreate();
    },

    /** 图转视频：这张图做首帧；可以带上动作建议和运镜预设 */
    toVideo: (asset: Asset, motion?: { prompt: string; camera?: string }) => {
      const camera = motion?.camera ? useCatalog.getState().presets.find((p) => p.kind === 'camera' && p.name === motion.camera)?.slug : undefined;
      setDraft({
        mode: 'video',
        recipe: { ...emptyRecipe('video'), text: motion?.prompt ?? '', presets: camera ? [camera] : [], parentAssetId: asset.id },
        firstFrameAssetId: asset.id,
      });
      goCreate();
    },

    /** 续拍（CRT-06）：截这段视频的最后一帧做首帧，接着生成下一段；沿用原任务的比例、清晰度、时长和预设 */
    continueShot: async (video: Asset, task?: Task | null) => {
      try {
        const frame = await api.frame(video.id, 'last');
        useStore.getState().upsertAssets([frame]);
        const base = task?.recipe ?? null;
        setDraft({
          mode: 'video',
          recipe: { ...emptyRecipe('video'), ...(base ? { presets: base.presets, overrides: base.overrides } : {}), text: '', parentAssetId: frame.id },
          firstFrameAssetId: frame.id,
        });
        goCreate();
        toast('已截取最后一帧做首帧，写下一段的动作就能续拍', 'success');
      } catch (error) {
        reportError(error);
      }
    },

    savePrompt: async (text: string, mode: 'image' | 'video') => {
      try {
        const saved = await api.savePrompt(text.slice(0, 16), text, mode);
        useCatalog.getState().addPrompt(saved);
        toast('已保存到我的提示词', 'success');
      } catch (error) {
        reportError(error);
      }
    },
  };
}
