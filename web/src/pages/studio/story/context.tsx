import { createContext, useContext } from 'react';
import type { Scene, Shot, StoryData } from '../../../../../shared/types.ts';
import { api, type NewTask } from '../../../lib/api.ts';
import { imageParams, videoParams } from '../../../lib/presets.ts';
import { reportError, useStore } from '../../../lib/store.ts';
import { characterRefs, keyframePrompt, videoPrompt, type Recipe, type ShotMedia } from './model.ts';

export interface StoryContextValue {
  storyId: string;
  data: StoryData;
  update: (recipe: Recipe) => void;
  media: Map<string, ShotMedia>;
  sceneId: string | null;
  setSceneId: (id: string | null) => void;
}

export const StoryContext = createContext<StoryContextValue | null>(null);

export function useStory(): StoryContextValue {
  const value = useContext(StoryContext);
  if (!value) throw new Error('StoryContext missing');
  return value;
}

const shotNumber = (scene: Scene, shot: Shot) => String(scene.shots.findIndex((s) => s.id === shot.id) + 1).padStart(2, '0');

/** 把分镜转成生成任务。关键帧走文生图（有角色定妆照时走图生图），视频优先用关键帧做图生视频 */
export function useShotGenerator() {
  const { storyId, data, media } = useStory();
  const upsertTasks = useStore((s) => s.upsertTasks);
  const toast = useStore((s) => s.toast);

  function keyframeTask(scene: Scene, shot: Shot, runNow: boolean): NewTask {
    const refs = characterRefs(data, shot);
    return {
      type: refs.length ? 'i2i' : 't2i',
      title: `${scene.title} · #${shotNumber(scene, shot)} 关键帧`,
      prompt: keyframePrompt(data, scene, shot),
      negativePrompt: '模糊，低质量，畸形，多余的手指，文字水印',
      params: imageParams(data.aspectRatio, '1k', refs.length ? { strength: 0.6 } : {}),
      inputs: { referenceAssetIds: refs },
      link: { storyId, shotId: shot.id, purpose: 'keyframe' },
      runNow,
    };
  }

  function videoTask(scene: Scene, shot: Shot, runNow: boolean): NewTask {
    const keyframe = media.get(shot.id)?.keyframe;
    return {
      type: keyframe ? 'i2v' : 't2v',
      title: `${scene.title} · #${shotNumber(scene, shot)} 视频`,
      prompt: videoPrompt(data, scene, shot),
      negativePrompt: '画面闪烁，人物变形，低质量',
      params: videoParams(data.aspectRatio, '720p', { duration: shot.duration }),
      inputs: { firstFrameAssetId: keyframe?.id ?? null },
      link: { storyId, shotId: shot.id, purpose: 'video' },
      runNow,
    };
  }

  async function submit(tasks: NewTask[], label: string) {
    if (!tasks.length) {
      toast('没有需要生成的镜头', 'info');
      return;
    }
    try {
      const created = tasks.length === 1 ? [await api.createTask(tasks[0])] : await api.createTasks(tasks);
      upsertTasks(created);
      toast(`${label}：已加入 ${created.length} 个任务`, 'success');
    } catch (error) {
      reportError(error);
    }
  }

  return {
    keyframe: (scene: Scene, shot: Shot, runNow = true) => submit([keyframeTask(scene, shot, runNow)], '关键帧'),
    video: (scene: Scene, shot: Shot, runNow = true) => submit([videoTask(scene, shot, runNow)], '视频'),
    /** 批量：只为没有结果且没有进行中任务的镜头生成 */
    batchKeyframes: (items: { scene: Scene; shot: Shot }[]) =>
      submit(
        items
          .filter(({ shot }) => !media.get(shot.id)?.keyframe && !media.get(shot.id)?.keyframeTask && shot.description.trim())
          .map(({ scene, shot }) => keyframeTask(scene, shot, false)),
        '批量关键帧',
      ),
    batchVideos: (items: { scene: Scene; shot: Shot }[]) =>
      submit(
        items
          .filter(({ shot }) => !media.get(shot.id)?.video && !media.get(shot.id)?.videoTask && shot.description.trim())
          .map(({ scene, shot }) => videoTask(scene, shot, false)),
        '批量视频',
      ),
  };
}
