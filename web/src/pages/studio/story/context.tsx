import { createContext, useContext } from 'react';
import { create } from 'zustand';
import { buildShotTask, portraitPrompt } from '../../../../../shared/story-prompt.ts';
import type { Character, Scene, Shot, StoryData } from '../../../../../shared/types.ts';
import { api } from '../../../lib/api.ts';
import { imageParams } from '../../../lib/presets.ts';
import { reportError, useStore } from '../../../lib/store.ts';
import { useChains } from './chains.ts';
import { flattenShots, updateShot, type Recipe, type ShotMedia } from './model.ts';

export { DEFAULT_KEYFRAME_NEGATIVE } from '../../../../../shared/story-prompt.ts';

export interface StoryContextValue {
  storyId: string;
  data: StoryData;
  update: (recipe: Recipe) => void;
  media: Map<string, ShotMedia>;
  sceneId: string | null;
  setSceneId: (id: string | null) => void;
  /** 立即提交未保存的修改（AI 改写、批量生成之前调用，服务端的快照才包含最新内容） */
  flushNow?: () => Promise<boolean>;
}

export const StoryContext = createContext<StoryContextValue | null>(null);

export function useStory(): StoryContextValue {
  const value = useContext(StoryContext);
  if (!value) throw new Error('StoryContext missing');
  return value;
}

export type BatchScope = { type: 'all' } | { type: 'chapter'; id: string; label?: string } | { type: 'scene'; id: string; label?: string } | { type: 'shots'; ids: string[] };

/** 批量生成对话框（由 StoryEditor 挂载） */
export const useBatchDialog = create<{ scope: BatchScope | null; content: 'keyframe' | 'video' | 'keyframe_then_video'; open: (scope: BatchScope, content?: 'keyframe' | 'video' | 'keyframe_then_video') => void; close: () => void }>(
  (set) => ({
    scope: null,
    content: 'keyframe',
    open: (scope, content = 'keyframe') => set({ scope, content }),
    close: () => set({ scope: null }),
  }),
);

/** 视频首帧：选定的关键帧 / 接续上一镜尾帧 / 指定素材 */
async function resolveFirstFrame(data: StoryData, shot: Shot, media: Map<string, ShotMedia>): Promise<string | null> {
  const mode = shot.firstFrame?.mode ?? 'keyframe';
  if (mode === 'asset' && shot.firstFrame?.assetId) return shot.firstFrame.assetId;
  if (mode === 'prev_last') {
    const flat = flattenShots(data);
    const index = flat.findIndex((item) => item.shot.id === shot.id);
    const prevVideo = index > 0 ? media.get(flat[index - 1].shot.id)?.video : null;
    if (prevVideo) {
      const frame = await api.frame(prevVideo.id, 'last');
      useStore.getState().upsertAssets([frame]);
      return frame.id;
    }
    useStore.getState().toast('上一镜还没有视频，改用本镜关键帧做首帧', 'info');
  }
  return media.get(shot.id)?.keyframe?.id ?? null;
}

/**
 * 把分镜转成生成任务（提示词由共享的构建器拼装，和服务端批量生成一致）。
 * 关键帧走文生图；视频优先用首帧做图生视频，并自动固定所用的关键帧。
 */
export function useShotGenerator() {
  const { storyId, data, media, update } = useStory();
  const upsertTasks = useStore((s) => s.upsertTasks);
  const toast = useStore((s) => s.toast);
  const caps = useStore((s) => s.capabilities);

  async function keyframe(scene: Scene, shot: Shot) {
    try {
      const task = await api.createTask({ ...buildShotTask(data, scene, shot, 'keyframe', { storyId, caps }), runNow: true });
      upsertTasks([task]);
      toast('关键帧：已加入队列', 'success');
    } catch (error) {
      reportError(error);
    }
  }

  async function video(scene: Scene, shot: Shot) {
    try {
      // 接续上一镜，但上一镜的视频还在生成：排在它后面，完成后服务端自动截尾帧生成这一镜
      if (shot.firstFrame?.mode === 'prev_last') {
        const flat = flattenShots(data);
        const index = flat.findIndex((item) => item.shot.id === shot.id);
        const prev = index > 0 ? flat[index - 1].shot : null;
        if (prev && media.get(prev.id)?.videoTask) {
          await api.addStoryChain(storyId, shot.id);
          void useChains.getState().refresh(storyId);
          toast('上一镜的视频还在生成，完成后会自动截它的尾帧接着生成这一镜', 'success');
          return;
        }
      }
      const first = await resolveFirstFrame(data, shot, media);
      const task = await api.createTask({ ...buildShotTask(data, scene, shot, 'video', { storyId, caps, firstFrameAssetId: first }), runNow: true });
      upsertTasks([task]);
      // 用它生成了视频：固定这张关键帧，之后出新候选也不会换掉
      const kf = media.get(shot.id)?.keyframe;
      if ((shot.firstFrame?.mode ?? 'keyframe') === 'keyframe' && kf && shot.keyframeAssetId !== kf.id) update(updateShot(scene.id, shot.id, { keyframeAssetId: kf.id }));
      toast('视频：已加入队列', 'success');
    } catch (error) {
      reportError(error);
    }
  }

  /** 定妆照：一次出 4 个候选 */
  async function portrait(character: Character) {
    if (!character.appearance.trim()) {
      toast('先填写角色外貌描述', 'info');
      return;
    }
    try {
      const task = await api.createTask({
        type: 't2i',
        title: `定妆照 · ${character.name}`,
        prompt: portraitPrompt(data, character),
        negativePrompt: ['多人，模糊，畸形，文字水印', character.negative].filter(Boolean).join('，'),
        params: imageParams('3:4', '1k', { count: Math.min(4, caps.image.maxCount || 1), seed: character.seed ?? null }, caps),
        link: { storyId, shotId: `char_${character.id}`, purpose: 'keyframe' },
        runNow: true,
      });
      upsertTasks([task]);
    } catch (error) {
      reportError(error);
    }
  }

  return {
    keyframe,
    video,
    portrait,
    /** 批量：打开批量生成对话框（服务端试算后执行） */
    batch: (scope: BatchScope, content: 'keyframe' | 'video' | 'keyframe_then_video' = 'keyframe') => useBatchDialog.getState().open(scope, content),
  };
}
