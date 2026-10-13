// 故事的增量操作（ops）：前端把两次编辑之间的差异算成 ops 提交，服务端按 ops 改表；
// 其他设备收到同样的 ops 应用到自己的内存模型上。撤销 / 重做就是切回上一版内容再算一次差异。
//
// 内存模型仍是 StoryData（章 → 场 → 台词 / 镜头，加角色和设定），每个列表里的顺序由排序键决定，
// 排序键单独放在一个 Map 里（不进 StoryData），移动一个元素只改它自己的排序键。
import type { Chapter, Character, DialogueLine, Scene, Shot, StoryData, StoryElement } from './types.ts';

export type StoryEntity = 'story' | 'character' | 'element' | 'chapter' | 'scene' | 'line' | 'shot';

export type StoryOp =
  /** 新建（已存在时按覆盖处理，方便断网重放） */
  | { op: 'create'; entity: Exclude<StoryEntity, 'story'>; id: string; parentId?: string | null; sortKey: string; value: Record<string, unknown> }
  /** 字段级修改：同一字段后写者胜 */
  | { op: 'set'; entity: StoryEntity; id: string; patch: Record<string, unknown> }
  /** 移动：只改排序键（和父级） */
  | { op: 'move'; entity: Exclude<StoryEntity, 'story'>; id: string; parentId?: string | null; sortKey: string }
  /** 删除：级联删除子节点 */
  | { op: 'delete'; entity: Exclude<StoryEntity, 'story'>; id: string };

/** 故事本身（标题 + 设定）在 ops 里的 id */
export const STORY_ID = 'story';

/** 故事级别可修改的字段（标题和设定，大纲也放在这里） */
export const STORY_FIELDS = ['title', 'logline', 'genre', 'tone', 'visualStyle', 'aspectRatio', 'outline', 'negativePrompt', 'targetDuration', 'defaultSeed'] as const;

export const ENTITY_FIELDS = {
  character: ['name', 'role', 'appearance', 'personality', 'referenceAssetId', 'aliases', 'seed', 'negative', 'outfits', 'refs', 'voice', 'seriesShared'],
  element: ['kind', 'name', 'snippet', 'negative', 'aliases', 'seed', 'refs', 'variants', 'seriesShared'],
  chapter: ['title', 'summary', 'recap'],
  scene: ['title', 'location', 'locationId', 'time', 'summary'],
  line: ['characterId', 'text', 'emotion', 'kind', 'voiceAssetId'],
  shot: [
    'shotSize',
    'cameraMove',
    'description',
    'dialogueIds',
    'duration',
    'characterIds',
    'elementIds',
    'keyframeAssetId',
    'videoAssetId',
    'code',
    'locked',
    'review',
    'seed',
    'extraPrompt',
    'negative',
    'promptOverride',
    'firstFrame',
    'trimIn',
    'trimOut',
    'transition',
    'storyboard',
  ],
} as const satisfies Record<Exclude<StoryEntity, 'story'>, readonly string[]>;

// ---------------- 排序键（分数索引） ----------------
// 键由 0-9a-z 组成，不以 0 结尾；在任意两个键之间总能插入新键。

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

/** a、b 之间的新键（a 为空表示最前，b 为空表示最后） */
export function keyBetween(a: string | null | undefined, b: string | null | undefined): string {
  const lo = a ?? '';
  const hi = b ?? null;
  if (hi !== null && lo >= hi) {
    // 键乱了（并发移动导致相等）：退回放在 a 后面
    return midpoint(lo, null);
  }
  return midpoint(lo, hi);
}

/** 一次生成 n 个等距的键（迁移、批量新建时用，长度只随数量对数增长） */
export function bulkKeys(n: number): string[] {
  const width = Math.max(1, Math.ceil(Math.log(n + 2) / Math.log(36)));
  return Array.from({ length: n }, (_, i) => (i + 1).toString(36).padStart(width, '0') + 'i');
}

export type SortKeys = Map<string, string>;

// ---------------- 遍历 ----------------

interface Node {
  entity: Exclude<StoryEntity, 'story'>;
  id: string;
  parentId: string | null;
  value: Record<string, unknown>;
}

/** 把 StoryData 拍平成 [实体, 父级, 字段]，子节点（场、台词、镜头）不放进父节点的字段里 */
function nodes(data: StoryData): Map<string, Node> {
  const out = new Map<string, Node>();
  const fields = (entity: Node['entity'], item: object) => {
    const value: Record<string, unknown> = {};
    for (const key of ENTITY_FIELDS[entity]) {
      const v = (item as Record<string, unknown>)[key];
      if (v !== undefined) value[key] = v;
    }
    return value;
  };
  for (const character of data.characters) out.set(character.id, { entity: 'character', id: character.id, parentId: null, value: fields('character', character) });
  for (const element of data.elements ?? []) out.set(element.id, { entity: 'element', id: element.id, parentId: null, value: fields('element', element) });
  for (const chapter of data.chapters) {
    out.set(chapter.id, { entity: 'chapter', id: chapter.id, parentId: null, value: fields('chapter', chapter) });
    for (const scene of chapter.scenes) {
      out.set(scene.id, { entity: 'scene', id: scene.id, parentId: chapter.id, value: fields('scene', scene) });
      for (const line of scene.dialogue) out.set(line.id, { entity: 'line', id: line.id, parentId: scene.id, value: fields('line', line) });
      for (const shot of scene.shots) out.set(shot.id, { entity: 'shot', id: shot.id, parentId: scene.id, value: fields('shot', shot) });
    }
  }
  return out;
}

/** 各个列表（同一父级、同一类实体）当前的顺序 */
function lists(data: StoryData): Map<string, string[]> {
  const out = new Map<string, string[]>();
  out.set('character:', data.characters.map((c) => c.id));
  out.set('element:', (data.elements ?? []).map((e) => e.id));
  out.set('chapter:', data.chapters.map((c) => c.id));
  for (const chapter of data.chapters) {
    out.set(`scene:${chapter.id}`, chapter.scenes.map((s) => s.id));
    for (const scene of chapter.scenes) {
      out.set(`line:${scene.id}`, scene.dialogue.map((l) => l.id));
      out.set(`shot:${scene.id}`, scene.shots.map((s) => s.id));
    }
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 最长递增子序列（返回下标集合）：顺序变化时，只移动不在其中的元素 */
function lisIndexes(values: number[]): Set<number> {
  const tails: number[] = [];
  const prev = new Array<number>(values.length).fill(-1);
  const tailIdx: number[] = [];
  values.forEach((value, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = value;
    tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  });
  const out = new Set<number>();
  let k = tailIdx[tails.length - 1] ?? -1;
  while (k >= 0) {
    out.add(k);
    k = prev[k];
  }
  return out;
}

const STORY_GETTERS: Record<(typeof STORY_FIELDS)[number], (data: StoryData, title: string) => unknown> = {
  title: (_d, t) => t,
  logline: (d) => d.logline,
  genre: (d) => d.genre,
  tone: (d) => d.tone,
  visualStyle: (d) => d.visualStyle,
  aspectRatio: (d) => d.aspectRatio,
  outline: (d) => d.outline,
  negativePrompt: (d) => d.negativePrompt,
  targetDuration: (d) => d.targetDuration,
  defaultSeed: (d) => d.defaultSeed,
};

/**
 * 两版内容之间的差异 → ops。keys 是当前的排序键，会就地补上新元素和移动元素的键。
 * 子节点跟着父节点一起删除时只发父节点的删除。
 */
export function diffStory(before: { title: string; data: StoryData }, after: { title: string; data: StoryData }, keys: SortKeys): StoryOp[] {
  const ops: StoryOp[] = [];
  // 故事本身
  const storyPatch: Record<string, unknown> = {};
  for (const field of STORY_FIELDS) {
    const a = STORY_GETTERS[field](before.data, before.title);
    const b = STORY_GETTERS[field](after.data, after.title);
    if (!same(a, b)) storyPatch[field] = b ?? null;
  }
  if (Object.keys(storyPatch).length) ops.push({ op: 'set', entity: 'story', id: STORY_ID, patch: storyPatch });
  if (before.data === after.data) return ops;

  const a = nodes(before.data);
  const b = nodes(after.data);
  // 删除：父节点也被删除的不重复发
  for (const [id, node] of a) {
    if (b.has(id)) continue;
    if (node.parentId && !b.has(node.parentId) && a.has(node.parentId)) continue;
    const grand = node.parentId ? a.get(node.parentId)?.parentId : null;
    if (grand && !b.has(grand)) continue;
    ops.push({ op: 'delete', entity: node.entity, id });
  }
  // 新建、修改、换父级、顺序变化：按列表处理，保证父节点先于子节点建出来
  const beforeLists = lists(before.data);
  const afterLists = lists(after.data);
  const order = ['character:', 'element:', 'chapter:'];
  const rest = [...afterLists.keys()].filter((key) => !order.includes(key));
  rest.sort((x, y) => (x.startsWith('scene:') ? 0 : 1) - (y.startsWith('scene:') ? 0 : 1));
  for (const listKey of [...order, ...rest]) {
    const ids = afterLists.get(listKey) ?? [];
    const entity = listKey.split(':')[0] as Node['entity'];
    const parentId = listKey.split(':')[1] || null;
    const old = beforeLists.get(listKey) ?? [];
    const oldIndex = new Map(old.map((id, i) => [id, i]));
    // 在原列表里、顺序没变的元素保持不动
    const stay = lisIndexes(ids.map((id) => oldIndex.get(id) ?? -1).filter((i) => i >= 0));
    let k = 0;
    const keep = new Set<string>();
    ids.forEach((id) => {
      if (oldIndex.has(id)) {
        if (stay.has(k)) keep.add(id);
        k++;
      }
    });
    ids.forEach((id, index) => {
      const node = b.get(id)!;
      const prevNode = a.get(id);
      const needsKey = !prevNode || !keep.has(id) || !keys.has(id);
      if (needsKey) {
        const prevKey = index > 0 ? keys.get(ids[index - 1]) : null;
        // 下一个已经排好的元素的键
        let nextKey: string | null = null;
        for (let j = index + 1; j < ids.length; j++) {
          if (keep.has(ids[j]) && keys.has(ids[j])) {
            nextKey = keys.get(ids[j])!;
            break;
          }
        }
        keys.set(id, keyBetween(prevKey, nextKey && prevKey && nextKey <= prevKey ? null : nextKey));
      }
      if (!prevNode) {
        ops.push({ op: 'create', entity, id, parentId, sortKey: keys.get(id)!, value: node.value });
        return;
      }
      if (needsKey || prevNode.parentId !== node.parentId) ops.push({ op: 'move', entity, id, parentId, sortKey: keys.get(id)! });
      const patch: Record<string, unknown> = {};
      for (const field of new Set([...Object.keys(prevNode.value), ...Object.keys(node.value)])) {
        if (!same(prevNode.value[field], node.value[field])) patch[field] = node.value[field] ?? null;
      }
      if (Object.keys(patch).length) ops.push({ op: 'set', entity, id, patch });
    });
  }
  return ops;
}

// ---------------- 在内存模型上应用 ops（其他设备的修改、断网重放） ----------------

function sortByKeys<T extends { id: string }>(items: T[], keys: SortKeys): T[] {
  return [...items].sort((x, y) => {
    const kx = keys.get(x.id) ?? '';
    const ky = keys.get(y.id) ?? '';
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
}

function emptyChapter(id: string, value: Record<string, unknown>): Chapter {
  return { id, title: '', summary: '', scenes: [], ...(value as object) } as Chapter;
}
function emptyScene(id: string, value: Record<string, unknown>): Scene {
  return { id, title: '', location: '', time: '', summary: '', dialogue: [], shots: [], ...(value as object) } as Scene;
}
function emptyShot(id: string, value: Record<string, unknown>): Shot {
  return {
    id,
    shotSize: '中景',
    cameraMove: '固定',
    description: '',
    dialogueIds: [],
    duration: 5,
    characterIds: [],
    keyframeAssetId: null,
    videoAssetId: null,
    ...(value as object),
  } as Shot;
}

export function applyStoryOps(state: { title: string; data: StoryData }, ops: StoryOp[], keys: SortKeys): { title: string; data: StoryData } {
  let title = state.title;
  const d: StoryData = structuredClone(state.data);
  d.elements ??= [];
  const findScene = (sceneId: string) => {
    for (const chapter of d.chapters) {
      const scene = chapter.scenes.find((s) => s.id === sceneId);
      if (scene) return scene;
    }
    return null;
  };
  const detach = (entity: StoryOp['entity'], id: string) => {
    if (entity === 'character') d.characters = d.characters.filter((c) => c.id !== id);
    else if (entity === 'element') d.elements = d.elements!.filter((e) => e.id !== id);
    else if (entity === 'chapter') d.chapters = d.chapters.filter((c) => c.id !== id);
    else if (entity === 'scene') for (const chapter of d.chapters) chapter.scenes = chapter.scenes.filter((s) => s.id !== id);
    else if (entity === 'line') for (const chapter of d.chapters) for (const scene of chapter.scenes) scene.dialogue = scene.dialogue.filter((l) => l.id !== id);
    else if (entity === 'shot') for (const chapter of d.chapters) for (const scene of chapter.scenes) scene.shots = scene.shots.filter((s) => s.id !== id);
  };
  const find = (entity: StoryOp['entity'], id: string): Record<string, unknown> | null => {
    if (entity === 'character') return (d.characters.find((c) => c.id === id) as unknown as Record<string, unknown>) ?? null;
    if (entity === 'element') return (d.elements!.find((e) => e.id === id) as unknown as Record<string, unknown>) ?? null;
    if (entity === 'chapter') return (d.chapters.find((c) => c.id === id) as unknown as Record<string, unknown>) ?? null;
    if (entity === 'scene') return (findScene(id) as unknown as Record<string, unknown>) ?? null;
    for (const chapter of d.chapters)
      for (const scene of chapter.scenes) {
        const hit = entity === 'line' ? scene.dialogue.find((l) => l.id === id) : scene.shots.find((s) => s.id === id);
        if (hit) return hit as unknown as Record<string, unknown>;
      }
    return null;
  };
  const attach = (entity: Exclude<StoryEntity, 'story'>, id: string, parentId: string | null | undefined, item: Record<string, unknown>) => {
    if (entity === 'character') d.characters = sortByKeys([...d.characters, item as unknown as Character], keys);
    else if (entity === 'element') d.elements = sortByKeys([...d.elements!, item as unknown as StoryElement], keys);
    else if (entity === 'chapter') d.chapters = sortByKeys([...d.chapters, item as unknown as Chapter], keys);
    else if (entity === 'scene') {
      const chapter = d.chapters.find((c) => c.id === parentId);
      if (chapter) chapter.scenes = sortByKeys([...chapter.scenes, item as unknown as Scene], keys);
    } else {
      const scene = parentId ? findScene(parentId) : null;
      if (!scene) return;
      if (entity === 'line') scene.dialogue = sortByKeys([...scene.dialogue, item as unknown as DialogueLine], keys);
      else scene.shots = sortByKeys([...scene.shots, item as unknown as Shot], keys);
    }
    void id;
  };
  for (const op of ops) {
    if (op.op === 'set' && op.entity === 'story') {
      for (const [field, value] of Object.entries(op.patch)) {
        if (field === 'title') title = String(value ?? '');
        else (d as unknown as Record<string, unknown>)[field] = value ?? (field === 'negativePrompt' || field === 'targetDuration' || field === 'defaultSeed' ? undefined : '');
      }
      continue;
    }
    if (op.entity === 'story') continue;
    if (op.op === 'delete') {
      detach(op.entity, op.id);
      continue;
    }
    if (op.op === 'create') {
      keys.set(op.id, op.sortKey);
      detach(op.entity, op.id);
      const value = op.value;
      const item =
        op.entity === 'chapter'
          ? emptyChapter(op.id, value)
          : op.entity === 'scene'
            ? emptyScene(op.id, value)
            : op.entity === 'shot'
              ? emptyShot(op.id, value)
              : op.entity === 'line'
                ? ({ id: op.id, characterId: null, text: '', emotion: '', ...value } as DialogueLine)
                : op.entity === 'character'
                  ? ({ id: op.id, name: '', role: '', appearance: '', personality: '', referenceAssetId: null, ...value } as Character)
                  : ({ id: op.id, kind: 'location', name: '', snippet: '', ...value } as StoryElement);
      attach(op.entity, op.id, op.parentId, item as unknown as Record<string, unknown>);
      continue;
    }
    const target = find(op.entity, op.id);
    if (!target) continue;
    if (op.op === 'set') {
      for (const [field, value] of Object.entries(op.patch)) {
        if (value === null && !['keyframeAssetId', 'videoAssetId', 'referenceAssetId', 'characterId', 'voiceAssetId', 'locationId', 'review', 'seed'].includes(field)) delete target[field];
        else target[field] = value;
      }
    } else if (op.op === 'move') {
      keys.set(op.id, op.sortKey);
      detach(op.entity, op.id);
      attach(op.entity, op.id, op.parentId, target);
    }
  }
  return { title, data: d };
}
