// 成片时间线（前端预览和服务端渲染共用）：每个镜头在片中的起点、时长（考虑裁剪点），以及配音在镜头内的位置
import type { DialogueLine, Scene, Shot, StoryData } from './types.ts';

/** 配音从镜头开始后多久开始、两句之间的间隔（秒） */
export const VOICE_LEAD = 0.3;
export const VOICE_GAP = 0.2;

export interface TimelineClip {
  shotId: string;
  sceneId: string;
  /** 在片中的起点（秒） */
  start: number;
  /** 在片中的时长（秒，已扣掉裁剪） */
  length: number;
  trimIn: number;
  trimOut: number | null;
  lines: DialogueLine[];
}

/** 镜头在成片里的时长：有视频时按视频长度和裁剪点算，没有视频时用镜头设定的时长 */
export function clipLength(shot: Pick<Shot, 'duration' | 'trimIn' | 'trimOut'>, videoDuration: number | null | undefined): number {
  if (!videoDuration) return Math.max(0.5, shot.duration || 0);
  const start = Math.min(Math.max(0, shot.trimIn ?? 0), videoDuration);
  const end = Math.min(videoDuration, shot.trimOut ?? videoDuration);
  return Math.max(0.1, end - start);
}

export function buildTimeline(data: StoryData, videoDuration: (shotId: string) => number | null | undefined): TimelineClip[] {
  const clips: TimelineClip[] = [];
  let start = 0;
  for (const chapter of data.chapters) {
    for (const scene of chapter.scenes) {
      for (const shot of scene.shots) {
        const length = clipLength(shot, videoDuration(shot.id));
        clips.push({ shotId: shot.id, sceneId: scene.id, start, length, trimIn: shot.trimIn ?? 0, trimOut: shot.trimOut ?? null, lines: linesOf(scene, shot) });
        start += length;
      }
    }
  }
  return clips;
}

function linesOf(scene: Scene, shot: Shot): DialogueLine[] {
  return shot.dialogueIds.map((id) => scene.dialogue.find((line) => line.id === id)).filter((line): line is DialogueLine => Boolean(line));
}

/** 一个镜头里各句配音的起点（相对镜头开始，秒）：按顺序排开 */
export function voiceOffsets(durations: number[]): number[] {
  const out: number[] = [];
  let at = VOICE_LEAD;
  for (const duration of durations) {
    out.push(at);
    at += duration + VOICE_GAP;
  }
  return out;
}

/** 按字数估算一句话的朗读时长（中文约每秒 4 字），模拟配音和预估用 */
export function estimateSpeech(text: string): number {
  const chars = [...text.replace(/\s+/g, '')].length;
  return Math.min(30, Math.max(0.8, Math.round((chars / 4) * 10) / 10));
}
