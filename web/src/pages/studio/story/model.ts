// 故事数据的不可变更新工具与提示词拼装。
// 只沿修改路径做浅拷贝，长篇故事（上千个镜头）编辑时也不会卡顿。
import type { Asset, Chapter, Character, DialogueLine, Scene, Shot, StoryData, Task } from '../../../../../shared/types.ts';
import { uid } from '../../../lib/util.ts';

export type Recipe = (data: StoryData) => StoryData;

export const newCharacter = (patch: Partial<Character> = {}): Character => ({
  id: uid('c_'),
  name: '新角色',
  role: '配角',
  appearance: '',
  personality: '',
  referenceAssetId: null,
  ...patch,
});

export const newDialogue = (patch: Partial<DialogueLine> = {}): DialogueLine => ({
  id: uid('d_'),
  characterId: null,
  text: '',
  emotion: '',
  ...patch,
});

export const newShot = (patch: Partial<Shot> = {}): Shot => ({
  id: uid('sh_'),
  shotSize: '中景',
  cameraMove: '固定',
  description: '',
  dialogueIds: [],
  duration: 5,
  characterIds: [],
  keyframeAssetId: null,
  videoAssetId: null,
  ...patch,
});

export const newScene = (patch: Partial<Scene> = {}): Scene => ({
  id: uid('sc_'),
  title: '新场次',
  location: '',
  time: '',
  summary: '',
  dialogue: [],
  shots: [],
  ...patch,
});

export const newChapter = (patch: Partial<Chapter> = {}): Chapter => ({
  id: uid('ch_'),
  title: '新章节',
  summary: '',
  scenes: [],
  ...patch,
});

export function updateChapter(chapterId: string, fn: (chapter: Chapter) => Chapter): Recipe {
  return (data) => ({ ...data, chapters: data.chapters.map((c) => (c.id === chapterId ? fn(c) : c)) });
}

export function updateScene(sceneId: string, fn: (scene: Scene) => Scene): Recipe {
  return (data) => ({
    ...data,
    chapters: data.chapters.map((chapter) =>
      chapter.scenes.some((s) => s.id === sceneId)
        ? { ...chapter, scenes: chapter.scenes.map((s) => (s.id === sceneId ? fn(s) : s)) }
        : chapter,
    ),
  });
}

export function updateShot(sceneId: string, shotId: string, patch: Partial<Shot>): Recipe {
  return updateScene(sceneId, (scene) => ({
    ...scene,
    shots: scene.shots.map((shot) => (shot.id === shotId ? { ...shot, ...patch } : shot)),
  }));
}

export function moveItem<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = list.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export interface FlatShot {
  shot: Shot;
  scene: Scene;
  chapter: Chapter;
  /** 全片序号，从 1 开始 */
  number: number;
  /** 场次内序号 */
  indexInScene: number;
}

export function flattenShots(data: StoryData): FlatShot[] {
  const result: FlatShot[] = [];
  for (const chapter of data.chapters) {
    for (const scene of chapter.scenes) {
      scene.shots.forEach((shot, indexInScene) =>
        result.push({ shot, scene, chapter, number: result.length + 1, indexInScene }),
      );
    }
  }
  return result;
}

export function findScene(data: StoryData, sceneId: string | null): { scene: Scene; chapter: Chapter } | null {
  if (!sceneId) return null;
  for (const chapter of data.chapters) {
    const scene = chapter.scenes.find((s) => s.id === sceneId);
    if (scene) return { scene, chapter };
  }
  return null;
}

function characterText(data: StoryData, ids: string[]): string {
  const chars = ids
    .map((id) => data.characters.find((c) => c.id === id))
    .filter((c): c is Character => Boolean(c) && Boolean(c?.appearance));
  return chars.length ? `出镜角色：${chars.map((c) => `${c.name}（${c.appearance}）`).join('；')}。` : '';
}

/** 分镜关键帧提示词：统一画风 + 场景 + 景别 + 画面描述 + 角色外貌，保证跨镜头一致 */
export function keyframePrompt(data: StoryData, scene: Scene, shot: Shot): string {
  return [
    data.visualStyle && `${data.visualStyle}。`,
    [scene.location, scene.time].filter(Boolean).join('，') && `${[scene.location, scene.time].filter(Boolean).join('，')}。`,
    `${shot.shotSize}。${shot.description}`,
    characterText(data, shot.characterIds),
  ]
    .filter(Boolean)
    .join('');
}

export function videoPrompt(data: StoryData, scene: Scene, shot: Shot): string {
  const lines = shot.dialogueIds
    .map((id) => scene.dialogue.find((d) => d.id === id))
    .filter((d): d is DialogueLine => Boolean(d?.text));
  const talk = lines.length
    ? `人物台词：${lines
        .map((line) => `${data.characters.find((c) => c.id === line.characterId)?.name ?? '旁白'}${line.emotion ? `（${line.emotion}）` : ''}：“${line.text}”`)
        .join(' ')}`
    : '';
  return [
    `${shot.cameraMove === '固定' ? '固定机位' : `${shot.cameraMove}镜头`}，${shot.shotSize}。${shot.description}。`,
    characterText(data, shot.characterIds),
    data.visualStyle && `风格：${data.visualStyle}。`,
    talk,
  ]
    .filter(Boolean)
    .join('');
}

export function dialogueFor(scene: Scene, shot: Shot): DialogueLine[] {
  return shot.dialogueIds
    .map((id) => scene.dialogue.find((d) => d.id === id))
    .filter((d): d is DialogueLine => Boolean(d));
}

export interface ShotMedia {
  keyframes: Asset[];
  videos: Asset[];
  keyframe: Asset | null;
  video: Asset | null;
  keyframeTask: Task | null;
  videoTask: Task | null;
}

const ACTIVE = new Set(['queued', 'running', 'paused']);

/** 汇总每个镜头的关键帧 / 视频素材与进行中的任务 */
export function buildShotMedia(storyId: string, assets: Record<string, Asset>, tasks: Record<string, Task>, data: StoryData) {
  const byShot = new Map<string, { keyframes: Asset[]; videos: Asset[]; keyframeTask: Task | null; videoTask: Task | null }>();
  const entry = (shotId: string) => {
    let item = byShot.get(shotId);
    if (!item) {
      item = { keyframes: [], videos: [], keyframeTask: null, videoTask: null };
      byShot.set(shotId, item);
    }
    return item;
  };
  for (const asset of Object.values(assets)) {
    if (asset.storyId !== storyId || !asset.shotId) continue;
    (asset.purpose === 'video' ? entry(asset.shotId).videos : entry(asset.shotId).keyframes).push(asset);
  }
  for (const task of Object.values(tasks)) {
    if (task.link.storyId !== storyId || !task.link.shotId || !ACTIVE.has(task.status)) continue;
    const item = entry(task.link.shotId);
    if (task.link.purpose === 'video') item.videoTask ??= task;
    else item.keyframeTask ??= task;
  }
  const result = new Map<string, ShotMedia>();
  for (const { shot } of flattenShots(data)) {
    const item = byShot.get(shot.id) ?? { keyframes: [], videos: [], keyframeTask: null, videoTask: null };
    item.keyframes.sort((a, b) => b.createdAt - a.createdAt);
    item.videos.sort((a, b) => b.createdAt - a.createdAt);
    // 用户手动选定的素材优先（可能来自资产库，不一定挂在本镜头下），否则用最新生成的
    const pinnedKeyframe = shot.keyframeAssetId ? assets[shot.keyframeAssetId] : undefined;
    const pinnedVideo = shot.videoAssetId ? assets[shot.videoAssetId] : undefined;
    if (pinnedKeyframe && !item.keyframes.includes(pinnedKeyframe)) item.keyframes.push(pinnedKeyframe);
    result.set(shot.id, {
      ...item,
      keyframe: pinnedKeyframe ?? item.keyframes[0] ?? null,
      video: pinnedVideo ?? item.videos[0] ?? null,
    });
  }
  return result;
}

export const EMPTY_MEDIA: ShotMedia = { keyframes: [], videos: [], keyframe: null, video: null, keyframeTask: null, videoTask: null };
