import type { StoryData } from '../../../../../shared/types.ts';
import { flattenShots, type ShotMedia } from './model.ts';

export type StepId = 'overview' | 'setup' | 'characters' | 'structure' | 'script' | 'shots' | 'preview';

export interface StepInfo {
  id: Exclude<StepId, 'overview'>;
  label: string;
  hint: string;
}

/** 六个创作步骤，按顺序引导用户把故事一步步搭起来 */
export const STEPS: StepInfo[] = [
  { id: 'setup', label: '设定与大纲', hint: '写下一句话故事，选好类型和画风，让 AI 扩写成完整大纲。' },
  { id: 'characters', label: '角色', hint: '设计主要角色。外貌描述和定妆照会自动用于每个镜头，保持角色一致。' },
  { id: 'structure', label: '章节场次', hint: '把大纲拆成章节和场次。长篇故事可以分多次追加，结构随时调整。' },
  { id: 'script', label: '剧本台词', hint: '逐场写剧情和对白，标注情绪。可以让 AI 先写一版再修改。' },
  { id: 'shots', label: '分镜', hint: '为每场设计镜头：景别、运镜、时长，再生成关键帧和视频。' },
  { id: 'preview', label: '成片', hint: '按顺序串联所有镜头预览整部作品，一键补齐缺失的画面。' },
];

export interface StoryStats {
  chapters: number;
  scenes: number;
  shots: number;
  keyframes: number;
  videos: number;
  dialogue: number;
  duration: number;
}

export function storyStats(data: StoryData, media: Map<string, ShotMedia>): StoryStats {
  const shots = flattenShots(data);
  const scenes = data.chapters.flatMap((c) => c.scenes);
  return {
    chapters: data.chapters.length,
    scenes: scenes.length,
    shots: shots.length,
    keyframes: shots.filter((s) => media.get(s.shot.id)?.keyframe).length,
    videos: shots.filter((s) => media.get(s.shot.id)?.video).length,
    dialogue: scenes.reduce((sum, s) => sum + s.dialogue.length, 0),
    duration: shots.reduce((sum, s) => sum + s.shot.duration, 0),
  };
}

export function stepDone(id: StepInfo['id'], data: StoryData, stats: StoryStats): boolean {
  const scenes = data.chapters.flatMap((c) => c.scenes);
  switch (id) {
    case 'setup':
      return Boolean(data.logline.trim() && data.outline.trim());
    case 'characters':
      return data.characters.length > 0;
    case 'structure':
      return scenes.length > 0;
    case 'script':
      return scenes.length > 0 && scenes.every((s) => s.summary.trim() || s.dialogue.length);
    case 'shots':
      return scenes.length > 0 && scenes.every((s) => s.shots.length > 0);
    case 'preview':
      return stats.shots > 0 && stats.videos === stats.shots;
  }
}

/** 第一个还没完成的步骤，用于“继续创作”引导 */
export function nextStep(data: StoryData, stats: StoryStats): StepInfo | null {
  return STEPS.find((step) => !stepDone(step.id, data, stats)) ?? null;
}
