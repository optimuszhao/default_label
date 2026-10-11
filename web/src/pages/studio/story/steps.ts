import type { StoryData } from '../../../../../shared/types.ts';
import { flattenShots, type ShotMedia } from './model.ts';

export type StepId = 'overview' | 'setup' | 'characters' | 'structure' | 'script' | 'shots' | 'preview' | 'layout';

export interface StepInfo {
  id: Exclude<StepId, 'overview'>;
  label: string;
  hint: string;
}

/** 六个创作步骤，按顺序引导用户把故事一步步搭起来 */
export const STEPS: StepInfo[] = [
  { id: 'setup', label: '设定与大纲', hint: '写下一句话故事，选好类型和画风，让 AI 扩写成完整大纲。' },
  { id: 'characters', label: '设定库', hint: '角色、地点、道具、画风。描述和参考图会自动用于每个镜头，保持全片一致。' },
  { id: 'structure', label: '章节场次', hint: '把大纲拆成章节和场次。长篇故事可以分多次追加，结构随时调整。' },
  { id: 'script', label: '剧本台词', hint: '逐场写剧情和对白，标注情绪。可以让 AI 先写一版再修改。' },
  { id: 'shots', label: '分镜', hint: '为每场设计镜头：景别、运镜、时长，再生成关键帧和视频。' },
  { id: 'preview', label: '成片', hint: '按顺序串联所有镜头预览整部作品，一键补齐缺失的画面。' },
];

export const LAYOUT_STEP: StepInfo = { id: 'layout', label: '图文排版', hint: '把镜头画面排成绘本、四格漫画或条漫，导出长图或打印成 PDF。' };

/** 按故事模板决定步骤：只出图的模板（绘本）没有成片，换成图文排版；带版式的模板在最后加上排版 */
export function stepsFor(template: { imageOnly?: boolean; layout?: string } | null): StepInfo[] {
  if (template?.imageOnly) return [...STEPS.filter((step) => step.id !== 'preview'), LAYOUT_STEP];
  if (template?.layout) return [...STEPS, LAYOUT_STEP];
  return STEPS;
}

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
    case 'layout':
      return false;
  }
}

/** 第一个还没完成的步骤，用于“继续创作”引导 */
export function nextStep(data: StoryData, stats: StoryStats, steps: StepInfo[] = STEPS): StepInfo | null {
  return steps.find((step) => !stepDone(step.id, data, stats)) ?? null;
}
