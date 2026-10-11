// 拆表后的故事读写：
//   loadStory      表 → 内存模型（StoryData + 排序键）
//   writeStory     内存模型 → 表（整篇覆盖：迁移、恢复历史版本、导入时用）
//   applyOps       增量操作 → 表（编辑器保存）
//   snapshotStory  存一份历史版本
import type { Character, DialogueLine, ElementRef, Scene, Shot, StoryData, StoryElement } from '../../shared/types.ts';
import { bulkKeys, ENTITY_FIELDS, STORY_FIELDS, STORY_ID, type StoryOp } from '../../shared/story-ops.ts';
import { db, newId, now, parseJson, type Row } from '../db.ts';
import { snapshotsToPrune } from './retention.ts';

export interface LoadedStory {
  title: string;
  data: StoryData;
  keys: Record<string, string>;
}

export interface StoryStats {
  chapters: number;
  scenes: number;
  shots: number;
  characters: number;
  lines: number;
  duration: number;
}

const SETTINGS_FIELDS = ['logline', 'genre', 'tone', 'visualStyle', 'aspectRatio', 'negativePrompt', 'targetDuration', 'defaultSeed'] as const;

export function defaultData(logline = ''): StoryData {
  return {
    logline,
    genre: '',
    tone: '',
    visualStyle: '电影质感，写实光影，35mm 胶片颗粒',
    aspectRatio: '16:9',
    outline: '',
    characters: [],
    elements: [],
    chapters: [],
  };
}

function outlineId(storyId: string): string {
  return `${storyId}:outline`;
}

// ---------------- 读 ----------------

export function loadStory(storyId: string): LoadedStory {
  const story = db.prepare('SELECT title, settings, series_id FROM stories WHERE id = ?').get(storyId) as Row;
  const seriesId = (story.series_id as string | null) ?? null;
  const settings = parseJson<Record<string, unknown>>(story.settings, {});
  const keys: Record<string, string> = {};
  const outline = db.prepare("SELECT content FROM story_docs WHERE story_id = ? AND kind = 'outline' LIMIT 1").get(storyId) as Row | undefined;

  const refs = new Map<string, ElementRef[]>();
  for (const row of db
    .prepare(
      `SELECT ea.entity_id, ea.asset_id, ea.role FROM entity_assets ea
       JOIN story_elements e ON e.id = ea.entity_id AND ea.entity_type = 'element'
       WHERE e.story_id = ? OR (e.series_id IS NOT NULL AND e.series_id = ?) ORDER BY ea.sort_key, ea.created_at`,
    )
    .all(storyId, seriesId) as Row[]) {
    const list = refs.get(String(row.entity_id)) ?? [];
    list.push({ assetId: String(row.asset_id), role: String(row.role) });
    refs.set(String(row.entity_id), list);
  }

  const characters: Character[] = [];
  const elements: StoryElement[] = [];
  const kindOf = new Map<string, string>();
  // 本故事的设定，加上同一系列里其他集共享出来的设定
  for (const row of db
    .prepare('SELECT * FROM story_elements WHERE (story_id = ? OR (series_id IS NOT NULL AND series_id = ?)) AND deleted_at IS NULL ORDER BY sort_key')
    .all(storyId, seriesId) as Row[]) {
    const id = String(row.id);
    keys[id] = String(row.sort_key);
    kindOf.set(id, String(row.kind));
    const data = parseJson<Record<string, unknown>>(row.data, {});
    const list = refs.get(id) ?? [];
    const primary = list.find((ref) => ref.role === 'primary');
    const others = list.filter((ref) => ref.role !== 'primary');
    if (row.kind === 'character') {
      characters.push({
        id,
        name: String(row.name),
        role: String(data.role ?? ''),
        appearance: String(row.snippet),
        personality: String(data.personality ?? ''),
        referenceAssetId: primary?.assetId ?? null,
        ...(data.aliases ? { aliases: data.aliases as string[] } : {}),
        ...(data.seed != null ? { seed: data.seed as number } : {}),
        ...(row.negative ? { negative: String(row.negative) } : {}),
        ...(data.outfits ? { outfits: data.outfits as Character['outfits'] } : {}),
        ...(others.length ? { refs: others } : {}),
        ...(data.seriesShared ? { seriesShared: true } : {}),
      });
    } else {
      elements.push({
        id,
        kind: row.kind as StoryElement['kind'],
        name: String(row.name),
        snippet: String(row.snippet),
        ...(row.negative ? { negative: String(row.negative) } : {}),
        ...(data.aliases ? { aliases: data.aliases as string[] } : {}),
        ...(data.seed != null ? { seed: data.seed as number } : {}),
        ...(list.length ? { refs: list } : {}),
        ...(data.variants ? { variants: data.variants as StoryElement['variants'] } : {}),
        ...(data.seriesShared ? { seriesShared: true } : {}),
      });
    }
  }

  const linesByScene = new Map<string, DialogueLine[]>();
  for (const row of db.prepare('SELECT * FROM story_lines WHERE story_id = ? ORDER BY sort_key').all(storyId) as Row[]) {
    keys[String(row.id)] = String(row.sort_key);
    const list = linesByScene.get(String(row.scene_id)) ?? [];
    list.push({
      id: String(row.id),
      characterId: (row.character_id as string | null) ?? null,
      text: String(row.text),
      emotion: String(row.emotion),
      ...(row.kind && row.kind !== 'dialogue' ? { kind: row.kind as DialogueLine['kind'] } : {}),
      ...(row.voice_asset_id ? { voiceAssetId: String(row.voice_asset_id) } : {}),
    });
    linesByScene.set(String(row.scene_id), list);
  }

  const shotLinks = new Map<string, string[]>();
  for (const row of db.prepare('SELECT shot_id, element_id FROM shot_elements WHERE story_id = ? ORDER BY sort').all(storyId) as Row[]) {
    const list = shotLinks.get(String(row.shot_id)) ?? [];
    list.push(String(row.element_id));
    shotLinks.set(String(row.shot_id), list);
  }

  const shotsByScene = new Map<string, Shot[]>();
  for (const row of db.prepare('SELECT * FROM story_shots WHERE story_id = ? ORDER BY sort_key').all(storyId) as Row[]) {
    const id = String(row.id);
    keys[id] = String(row.sort_key);
    const data = parseJson<Record<string, unknown>>(row.data, {});
    const linked = shotLinks.get(id) ?? [];
    const characterIds = linked.filter((el) => (kindOf.get(el) ?? 'character') === 'character');
    const elementIds = linked.filter((el) => kindOf.has(el) && kindOf.get(el) !== 'character');
    const shot: Shot = {
      id,
      shotSize: String(row.shot_size),
      cameraMove: String(row.camera_move),
      description: String(row.description),
      dialogueIds: (data.dialogueIds as string[]) ?? [],
      duration: Number(row.duration),
      characterIds,
      keyframeAssetId: (row.keyframe_asset_id as string | null) ?? null,
      videoAssetId: (row.video_asset_id as string | null) ?? null,
    };
    if (row.code) shot.code = String(row.code);
    if (elementIds.length) shot.elementIds = elementIds;
    if (Number(row.locked) === 1) shot.locked = true;
    if (row.review) shot.review = row.review as Shot['review'];
    for (const field of ['seed', 'extraPrompt', 'negative', 'promptOverride', 'firstFrame', 'trimIn', 'trimOut', 'transition'] as const) {
      if (data[field] !== undefined && data[field] !== null) (shot as unknown as Record<string, unknown>)[field] = data[field];
    }
    const list = shotsByScene.get(String(row.scene_id)) ?? [];
    list.push(shot);
    shotsByScene.set(String(row.scene_id), list);
  }

  const scenesByChapter = new Map<string, Scene[]>();
  for (const row of db.prepare('SELECT * FROM story_scenes WHERE story_id = ? ORDER BY sort_key').all(storyId) as Row[]) {
    const id = String(row.id);
    keys[id] = String(row.sort_key);
    const list = scenesByChapter.get(String(row.chapter_id)) ?? [];
    list.push({
      id,
      title: String(row.title),
      location: String(row.location_text),
      ...(row.location_id ? { locationId: String(row.location_id) } : {}),
      time: String(row.time_text),
      summary: String(row.script),
      dialogue: linesByScene.get(id) ?? [],
      shots: shotsByScene.get(id) ?? [],
    } as Scene);
    scenesByChapter.set(String(row.chapter_id), list);
  }

  const chapters = (db.prepare('SELECT * FROM story_chapters WHERE story_id = ? ORDER BY sort_key').all(storyId) as Row[]).map((row) => {
    keys[String(row.id)] = String(row.sort_key);
    return {
      id: String(row.id),
      title: String(row.title),
      summary: String(row.summary),
      ...(row.recap ? { recap: String(row.recap) } : {}),
      scenes: scenesByChapter.get(String(row.id)) ?? [],
    };
  });

  const data: StoryData = {
    ...defaultData(),
    logline: String(settings.logline ?? ''),
    genre: String(settings.genre ?? ''),
    tone: String(settings.tone ?? ''),
    visualStyle: String(settings.visualStyle ?? defaultData().visualStyle),
    aspectRatio: String(settings.aspectRatio ?? '16:9'),
    outline: String(outline?.content ?? ''),
    characters,
    elements,
    chapters,
  };
  if (settings.negativePrompt) data.negativePrompt = String(settings.negativePrompt);
  if (settings.targetDuration != null) data.targetDuration = Number(settings.targetDuration);
  if (settings.defaultSeed != null) data.defaultSeed = Number(settings.defaultSeed);
  return { title: String(story.title), data, keys };
}

export function computeStats(storyId: string): StoryStats {
  const count = (table: string, extra = '') => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE story_id = ?${extra}`).get(storyId) as Row).n);
  const duration = Number((db.prepare('SELECT COALESCE(SUM(duration), 0) AS d FROM story_shots WHERE story_id = ?').get(storyId) as Row).d);
  return {
    chapters: count('story_chapters'),
    scenes: count('story_scenes'),
    shots: count('story_shots'),
    characters: count('story_elements', " AND kind = 'character' AND deleted_at IS NULL"),
    lines: count('story_lines'),
    duration,
  };
}

function saveStats(storyId: string): void {
  db.prepare('UPDATE stories SET stats = ? WHERE id = ?').run(JSON.stringify(computeStats(storyId)), storyId);
}

// ---------------- 写：整篇覆盖 ----------------

function setRefs(elementId: string, referenceAssetId: string | null | undefined, refs: ElementRef[] | undefined, kind: string): void {
  db.prepare("DELETE FROM entity_assets WHERE entity_type = 'element' AND entity_id = ?").run(elementId);
  const insert = db.prepare("INSERT OR IGNORE INTO entity_assets (entity_type, entity_id, asset_id, role, sort_key, created_at) VALUES ('element', ?, ?, ?, ?, ?)");
  const list: ElementRef[] = [];
  if (kind === 'character' && referenceAssetId) list.push({ assetId: referenceAssetId, role: 'primary' });
  for (const ref of refs ?? []) if (ref?.assetId) list.push(ref);
  const keys = bulkKeys(list.length);
  list.forEach((ref, i) => insert.run(elementId, ref.assetId, ref.role || 'reference', keys[i], now()));
}

function setShotElements(storyId: string, shotId: string, ids: string[]): void {
  db.prepare('DELETE FROM shot_elements WHERE shot_id = ?').run(shotId);
  const insert = db.prepare('INSERT OR IGNORE INTO shot_elements (shot_id, element_id, story_id, sort) VALUES (?, ?, ?, ?)');
  [...new Set(ids)].forEach((id, i) => insert.run(shotId, id, storyId, i));
}

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) if (source[field] !== undefined && source[field] !== null) out[field] = source[field];
  return out;
}

function insertElement(storyId: string, userId: string, item: Record<string, unknown>, kind: string, sortKey: string): void {
  const ts = now();
  const data =
    kind === 'character'
      ? pick(item, ['role', 'personality', 'aliases', 'seed', 'outfits', 'seriesShared'])
      : pick(item, ['aliases', 'seed', 'variants', 'seriesShared']);
  const seriesId = item.seriesShared ? (((db.prepare('SELECT series_id FROM stories WHERE id = ?').get(storyId) as Row | undefined)?.series_id as string | null) ?? null) : null;
  db.prepare(
    `INSERT INTO story_elements (id, user_id, story_id, series_id, kind, name, sort_key, snippet, negative, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET story_id = COALESCE(story_elements.story_id, excluded.story_id), series_id = excluded.series_id, kind = excluded.kind,
       name = excluded.name, sort_key = excluded.sort_key, snippet = excluded.snippet, negative = excluded.negative, data = excluded.data,
       deleted_at = NULL, updated_at = excluded.updated_at`,
  ).run(
    String(item.id),
    userId,
    storyId,
    seriesId,
    kind,
    String(item.name ?? ''),
    sortKey,
    String((kind === 'character' ? item.appearance : item.snippet) ?? ''),
    String(item.negative ?? ''),
    JSON.stringify(data),
    ts,
    ts,
  );
  setRefs(String(item.id), item.referenceAssetId as string | null, item.refs as ElementRef[] | undefined, kind);
}

function insertChapter(storyId: string, item: Record<string, unknown>, sortKey: string): void {
  const ts = now();
  db.prepare(
    `INSERT INTO story_chapters (id, story_id, sort_key, title, summary, recap, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET sort_key = excluded.sort_key, title = excluded.title, summary = excluded.summary, recap = excluded.recap, updated_at = excluded.updated_at`,
  ).run(String(item.id), storyId, sortKey, String(item.title ?? ''), String(item.summary ?? ''), String(item.recap ?? ''), ts, ts);
}

function insertScene(storyId: string, chapterId: string, item: Record<string, unknown>, sortKey: string): void {
  const ts = now();
  db.prepare(
    `INSERT INTO story_scenes (id, story_id, chapter_id, sort_key, title, location_id, location_text, time_text, script, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET chapter_id = excluded.chapter_id, sort_key = excluded.sort_key, title = excluded.title, location_id = excluded.location_id,
       location_text = excluded.location_text, time_text = excluded.time_text, script = excluded.script, updated_at = excluded.updated_at`,
  ).run(
    String(item.id),
    storyId,
    chapterId,
    sortKey,
    String(item.title ?? ''),
    (item.locationId as string | null) ?? null,
    String(item.location ?? ''),
    String(item.time ?? ''),
    String(item.summary ?? ''),
    ts,
    ts,
  );
}

function insertLine(storyId: string, sceneId: string, item: Record<string, unknown>, sortKey: string): void {
  db.prepare(
    `INSERT INTO story_lines (id, story_id, scene_id, sort_key, character_id, kind, text, emotion, voice_asset_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET scene_id = excluded.scene_id, sort_key = excluded.sort_key, character_id = excluded.character_id, kind = excluded.kind,
       text = excluded.text, emotion = excluded.emotion, voice_asset_id = excluded.voice_asset_id, updated_at = excluded.updated_at`,
  ).run(
    String(item.id),
    storyId,
    sceneId,
    sortKey,
    (item.characterId as string | null) ?? null,
    String(item.kind ?? 'dialogue'),
    String(item.text ?? ''),
    String(item.emotion ?? ''),
    (item.voiceAssetId as string | null) ?? null,
    now(),
  );
}

const SHOT_DATA_FIELDS = ['dialogueIds', 'seed', 'extraPrompt', 'negative', 'promptOverride', 'firstFrame', 'trimIn', 'trimOut', 'transition'] as const;

function insertShot(storyId: string, sceneId: string, item: Record<string, unknown>, sortKey: string): void {
  const ts = now();
  db.prepare(
    `INSERT INTO story_shots (id, story_id, scene_id, sort_key, code, shot_size, camera_move, duration, description, keyframe_asset_id, video_asset_id, locked, review, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET scene_id = excluded.scene_id, sort_key = excluded.sort_key, code = excluded.code, shot_size = excluded.shot_size,
       camera_move = excluded.camera_move, duration = excluded.duration, description = excluded.description, keyframe_asset_id = excluded.keyframe_asset_id,
       video_asset_id = excluded.video_asset_id, locked = excluded.locked, review = excluded.review, data = excluded.data, updated_at = excluded.updated_at`,
  ).run(
    String(item.id),
    storyId,
    sceneId,
    sortKey,
    String(item.code ?? ''),
    String(item.shotSize ?? ''),
    String(item.cameraMove ?? ''),
    Number(item.duration ?? 5) || 5,
    String(item.description ?? ''),
    (item.keyframeAssetId as string | null) ?? null,
    (item.videoAssetId as string | null) ?? null,
    item.locked ? 1 : 0,
    (item.review as string | null) ?? null,
    JSON.stringify(pick(item, SHOT_DATA_FIELDS)),
    ts,
    ts,
  );
  setShotElements(storyId, String(item.id), [...((item.characterIds as string[]) ?? []), ...((item.elementIds as string[]) ?? [])]);
}

function writeSettings(storyId: string, title: string | null, data: Partial<StoryData>): void {
  const row = db.prepare('SELECT settings FROM stories WHERE id = ?').get(storyId) as Row;
  const settings = parseJson<Record<string, unknown>>(row.settings, {});
  for (const field of SETTINGS_FIELDS) {
    if (field in data) {
      const value = (data as Record<string, unknown>)[field];
      if (value === undefined || value === null) delete settings[field];
      else settings[field] = value;
    }
  }
  db.prepare(`UPDATE stories SET settings = ?${title !== null ? ', title = ?' : ''} WHERE id = ?`).run(
    JSON.stringify(settings),
    ...(title !== null ? [title.trim().slice(0, 80) || '未命名故事'] : []),
    storyId,
  );
  if ('outline' in data) {
    db.prepare(
      `INSERT INTO story_docs (id, story_id, kind, title, content, updated_at) VALUES (?, ?, 'outline', '大纲', ?, ?)
       ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    ).run(outlineId(storyId), storyId, String(data.outline ?? ''), now());
  }
}

/** 整篇覆盖（在调用方的事务里执行）：删掉全部子表行，按内存模型重新写入，保留原来的 id */
export function writeStory(storyId: string, userId: string, title: string, data: StoryData): void {
  for (const table of ['story_shots', 'story_lines', 'story_scenes', 'story_chapters', 'shot_elements']) db.prepare(`DELETE FROM ${table} WHERE story_id = ?`).run(storyId);
  const oldElements = db.prepare('SELECT id FROM story_elements WHERE story_id = ?').all(storyId) as Row[];
  for (const row of oldElements) db.prepare("DELETE FROM entity_assets WHERE entity_type = 'element' AND entity_id = ?").run(String(row.id));
  db.prepare('DELETE FROM story_elements WHERE story_id = ?').run(storyId);
  writeSettings(storyId, title, data);
  const characterKeys = bulkKeys(data.characters.length);
  data.characters.forEach((item, i) => insertElement(storyId, userId, item as unknown as Record<string, unknown>, 'character', characterKeys[i]));
  const elements = data.elements ?? [];
  const elementKeys = bulkKeys(elements.length);
  elements.forEach((item, i) => insertElement(storyId, userId, item as unknown as Record<string, unknown>, item.kind, elementKeys[i]));
  const chapterKeys = bulkKeys(data.chapters.length);
  data.chapters.forEach((chapter, ci) => {
    insertChapter(storyId, chapter as unknown as Record<string, unknown>, chapterKeys[ci]);
    const sceneKeys = bulkKeys(chapter.scenes.length);
    chapter.scenes.forEach((scene, si) => {
      insertScene(storyId, chapter.id, scene as unknown as Record<string, unknown>, sceneKeys[si]);
      const lineKeys = bulkKeys(scene.dialogue.length);
      scene.dialogue.forEach((line, li) => insertLine(storyId, scene.id, line as unknown as Record<string, unknown>, lineKeys[li]));
      const shotKeys = bulkKeys(scene.shots.length);
      scene.shots.forEach((shot, hi) => insertShot(storyId, scene.id, shot as unknown as Record<string, unknown>, shotKeys[hi]));
    });
  });
  saveStats(storyId);
}

// ---------------- 写：增量 ops ----------------

const COLUMN: Record<string, Record<string, string>> = {
  chapter: { title: 'title', summary: 'summary', recap: 'recap' },
  scene: { title: 'title', location: 'location_text', locationId: 'location_id', time: 'time_text', summary: 'script' },
  line: { characterId: 'character_id', text: 'text', emotion: 'emotion', kind: 'kind', voiceAssetId: 'voice_asset_id' },
  shot: {
    shotSize: 'shot_size',
    cameraMove: 'camera_move',
    duration: 'duration',
    description: 'description',
    keyframeAssetId: 'keyframe_asset_id',
    videoAssetId: 'video_asset_id',
    code: 'code',
    locked: 'locked',
    review: 'review',
  },
  character: { name: 'name', appearance: 'snippet', negative: 'negative' },
  element: { name: 'name', snippet: 'snippet', negative: 'negative', kind: 'kind' },
};

const TABLE: Record<string, string> = {
  chapter: 'story_chapters',
  scene: 'story_scenes',
  line: 'story_lines',
  shot: 'story_shots',
  character: 'story_elements',
  element: 'story_elements',
};

/** 文本字段的长度上限：防止一次塞进超大内容 */
function clean(field: string, value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, field === 'summary' || field === 'outline' || field === 'description' ? 50_000 : 4000);
  return value;
}

function columnValue(entity: string, column: string, value: unknown): unknown {
  if (column === 'locked') return value ? 1 : 0;
  if (column === 'duration') return Number(value) || 5;
  if (value === undefined) return null;
  if (value === null) return ['keyframe_asset_id', 'video_asset_id', 'character_id', 'voice_asset_id', 'location_id', 'review'].includes(column) ? null : '';
  void entity;
  return value;
}

function parentOk(storyId: string, entity: string, parentId: string | null | undefined): boolean {
  if (entity === 'scene') return Boolean(parentId && db.prepare('SELECT 1 FROM story_chapters WHERE id = ? AND story_id = ?').get(parentId, storyId));
  if (entity === 'line' || entity === 'shot') return Boolean(parentId && db.prepare('SELECT 1 FROM story_scenes WHERE id = ? AND story_id = ?').get(parentId, storyId));
  return true;
}

const SHARED = `(story_id = ? OR (series_id IS NOT NULL AND series_id = (SELECT series_id FROM stories WHERE id = ?)))`;

function exists(storyId: string, entity: string, id: string): boolean {
  if (entity === 'character' || entity === 'element') return Boolean(db.prepare(`SELECT 1 FROM story_elements WHERE id = ? AND ${SHARED}`).get(id, storyId, storyId));
  return Boolean(db.prepare(`SELECT 1 FROM ${TABLE[entity]} WHERE id = ? AND story_id = ?`).get(id, storyId));
}

/** 别的故事已经占用了这个 id（防止通过 ops 改别人的数据）；同一系列共享的设定不算 */
function foreign(storyId: string, entity: string, id: string): boolean {
  if (entity === 'character' || entity === 'element') return Boolean(db.prepare(`SELECT 1 FROM story_elements WHERE id = ? AND NOT ${SHARED}`).get(id, storyId, storyId));
  return Boolean(db.prepare(`SELECT 1 FROM ${TABLE[entity]} WHERE id = ? AND COALESCE(story_id, '') <> ?`).get(id, storyId));
}

export interface ApplyResult {
  applied: number;
  ignored: { index: number; reason: string }[];
  structural: boolean;
}

/** 在调用方的事务里按顺序执行 ops；指向不存在实体的 op 记入 ignored */
export function applyOps(storyId: string, userId: string, ops: StoryOp[]): ApplyResult {
  const result: ApplyResult = { applied: 0, ignored: [], structural: false };
  ops.forEach((op, index) => {
    const ignore = (reason: string) => result.ignored.push({ index, reason });
    if (op.entity === 'story') {
      if (op.op !== 'set' || op.id !== STORY_ID) return ignore('故事只能修改字段');
      const patch: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(op.patch)) if ((STORY_FIELDS as readonly string[]).includes(field)) patch[field] = clean(field, value);
      const title = typeof patch.title === 'string' ? patch.title : null;
      delete patch.title;
      writeSettings(storyId, title, patch as Partial<StoryData>);
      result.applied++;
      return;
    }
    const entity = op.entity;
    if (!TABLE[entity]) return ignore('未知的实体');
    if (op.op === 'delete') {
      if (!exists(storyId, entity, op.id)) return ignore('已不存在');
      if (entity === 'character' || entity === 'element') {
        db.prepare("DELETE FROM entity_assets WHERE entity_type = 'element' AND entity_id = ?").run(op.id);
        db.prepare('DELETE FROM shot_elements WHERE element_id = ?').run(op.id);
        db.prepare('DELETE FROM story_elements WHERE id = ?').run(op.id);
      } else {
        if (entity === 'shot') db.prepare('DELETE FROM shot_elements WHERE shot_id = ?').run(op.id);
        if (entity === 'scene') db.prepare('DELETE FROM shot_elements WHERE shot_id IN (SELECT id FROM story_shots WHERE scene_id = ?)').run(op.id);
        if (entity === 'chapter')
          db.prepare('DELETE FROM shot_elements WHERE shot_id IN (SELECT sh.id FROM story_shots sh JOIN story_scenes sc ON sc.id = sh.scene_id WHERE sc.chapter_id = ?)').run(op.id);
        db.prepare(`DELETE FROM ${TABLE[entity]} WHERE id = ? AND story_id = ?`).run(op.id, storyId);
      }
      result.applied++;
      result.structural = true;
      return;
    }
    if (foreign(storyId, entity, op.id)) return ignore('id 冲突');
    if (op.op === 'create') {
      if (!parentOk(storyId, entity, op.parentId)) return ignore('上级已不存在');
      const value: Record<string, unknown> = { id: op.id };
      for (const field of ENTITY_FIELDS[entity]) if (op.value[field] !== undefined) value[field] = clean(field, op.value[field]);
      const key = String(op.sortKey).slice(0, 200) || 'i';
      if (entity === 'character') insertElement(storyId, userId, value, 'character', key);
      else if (entity === 'element') insertElement(storyId, userId, value, String(value.kind ?? 'location'), key);
      else if (entity === 'chapter') insertChapter(storyId, value, key);
      else if (entity === 'scene') insertScene(storyId, op.parentId!, value, key);
      else if (entity === 'line') insertLine(storyId, op.parentId!, value, key);
      else insertShot(storyId, op.parentId!, value, key);
      result.applied++;
      result.structural = true;
      return;
    }
    if (!exists(storyId, entity, op.id)) return ignore('已不存在');
    if (op.op === 'move') {
      const parentColumn = entity === 'scene' ? 'chapter_id' : entity === 'line' || entity === 'shot' ? 'scene_id' : null;
      if (parentColumn && op.parentId) {
        if (!parentOk(storyId, entity, op.parentId)) return ignore('上级已不存在');
        db.prepare(`UPDATE ${TABLE[entity]} SET sort_key = ?, ${parentColumn} = ?, updated_at = ? WHERE id = ?`).run(String(op.sortKey).slice(0, 200), op.parentId, now(), op.id);
      } else {
        db.prepare(`UPDATE ${TABLE[entity]} SET sort_key = ?, updated_at = ? WHERE id = ?`).run(String(op.sortKey).slice(0, 200), now(), op.id);
      }
      result.applied++;
      result.structural = true;
      return;
    }
    // set：列字段直接改；其他字段合并进 data；出镜设定和参考图单独维护
    const columns = COLUMN[entity];
    const sets: string[] = [];
    const args: unknown[] = [];
    const dataPatch: Record<string, unknown> = {};
    let links: string[] | null = null;
    for (const [field, raw] of Object.entries(op.patch)) {
      if (!(ENTITY_FIELDS[entity] as readonly string[]).includes(field)) continue;
      const value = clean(field, raw);
      if (entity === 'shot' && (field === 'characterIds' || field === 'elementIds')) {
        const current: string[] = links ?? (db.prepare('SELECT element_id FROM shot_elements WHERE shot_id = ? ORDER BY sort').all(op.id) as Row[]).map((row) => String(row.element_id));
        const kinds = new Map(
          (db.prepare(`SELECT id, kind FROM story_elements WHERE id IN (${current.map(() => '?').join(',') || "''"})`).all(...current) as Row[]).map((row) => [String(row.id), String(row.kind)]),
        );
        const keepOther: string[] = current.filter((id) => (field === 'characterIds' ? kinds.get(id) && kinds.get(id) !== 'character' : (kinds.get(id) ?? 'character') === 'character'));
        links = field === 'characterIds' ? [...((value as string[]) ?? []), ...keepOther] : [...keepOther, ...((value as string[]) ?? [])];
        continue;
      }
      if ((entity === 'character' || entity === 'element') && (field === 'referenceAssetId' || field === 'refs')) {
        const row = db.prepare('SELECT kind FROM story_elements WHERE id = ?').get(op.id) as Row;
        const current = loadRefs(op.id);
        const primary = field === 'referenceAssetId' ? (value as string | null) : (current.find((r) => r.role === 'primary')?.assetId ?? null);
        const others = field === 'refs' ? ((value as ElementRef[]) ?? []) : current.filter((r) => r.role !== 'primary');
        setRefs(op.id, primary, others, String(row.kind));
        continue;
      }
      if ((entity === 'character' || entity === 'element') && field === 'seriesShared') {
        const series = value ? ((db.prepare('SELECT series_id FROM stories WHERE id = ?').get(storyId) as Row | undefined)?.series_id ?? null) : null;
        sets.push('series_id = ?');
        args.push(series);
      }
      const column = columns[field];
      if (column) {
        sets.push(`${column} = ?`);
        args.push(columnValue(entity, column, value));
      } else {
        dataPatch[field] = value;
      }
    }
    if (Object.keys(dataPatch).length) {
      const row = db.prepare(`SELECT data FROM ${TABLE[entity]} WHERE id = ?`).get(op.id) as Row;
      const data = parseJson<Record<string, unknown>>(row.data, {});
      for (const [field, value] of Object.entries(dataPatch)) {
        if (value === null || value === undefined) delete data[field];
        else data[field] = value;
      }
      sets.push('data = ?');
      args.push(JSON.stringify(data));
    }
    if (sets.length) db.prepare(`UPDATE ${TABLE[entity]} SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...(args as never[]), now(), op.id);
    if (links) setShotElements(storyId, op.id, links);
    if (entity === 'shot' && 'duration' in op.patch) result.structural = true;
    result.applied++;
  });
  if (result.structural) saveStats(storyId);
  return result;
}

function loadRefs(elementId: string): ElementRef[] {
  return (db.prepare("SELECT asset_id, role FROM entity_assets WHERE entity_type = 'element' AND entity_id = ? ORDER BY sort_key, created_at").all(elementId) as Row[]).map((row) => ({
    assetId: String(row.asset_id),
    role: String(row.role),
  }));
}

// ---------------- 历史版本 ----------------

export function snapshotStory(storyId: string, reason: string, options: { label?: string | null; pinned?: boolean } = {}): string {
  const row = db.prepare('SELECT * FROM stories WHERE id = ?').get(storyId) as Row;
  const content = Number(row.schema) === 2 ? loadStory(storyId) : { title: String(row.title), data: parseJson<StoryData>(row.data, defaultData()) };
  const stats = Number(row.schema) === 2 ? computeStats(storyId) : null;
  const id = newId('ss_');
  db.prepare('INSERT INTO story_snapshots (id, story_id, rev, title, data, reason, label, pinned, stats, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    storyId,
    Number(row.rev ?? 0),
    content.title,
    JSON.stringify(content.data),
    reason,
    options.label ?? null,
    options.pinned ? 1 : 0,
    stats ? JSON.stringify(stats) : null,
    now(),
  );
  return id;
}

export function pruneSnapshots(storyId: string, at = now()): number {
  const rows = (db.prepare('SELECT id, created_at, pinned FROM story_snapshots WHERE story_id = ?').all(storyId) as Row[]).map((row) => ({
    id: String(row.id),
    createdAt: Number(row.created_at),
    pinned: Number(row.pinned) === 1,
  }));
  const remove = snapshotsToPrune(rows, at);
  for (const id of remove) db.prepare('DELETE FROM story_snapshots WHERE id = ?').run(id);
  return remove.length;
}
