// 故事包（EXP-04）：.weave.zip = story.json（结构和设定）+ assets.json（素材清单）+ assets/ 下的素材文件。
// 导出时带上所有选定的画面、每个镜头当前生效的候选、角色定妆照和参考图、配音；
// 导入时故事、章节、场次、台词、镜头、设定、素材的 id 全部重新生成，引用随之改写。
import fs from 'node:fs/promises';
import type { Asset, StoryData } from '../../shared/types.ts';
import { db, type Row } from '../db.ts';
import { absoluteFile, newTempFile, saveAsset } from '../files.ts';
import type { ZipEntry } from '../media/zip.ts';
import { extractEntry, readEntry, readZipIndex } from '../media/unzip.ts';
import { effectiveMedia } from './batch.ts';
import { AI_NOTICE } from './export.ts';
import { loadStory } from './store.ts';

export const PACKAGE_FORMAT = 'weave-story';
export const PACKAGE_VERSION = 1;

interface PackageAsset {
  id: string;
  path: string;
  kind: Asset['kind'];
  mime: string;
  source: Asset['source'];
  purpose: Asset['purpose'];
  shotId: string | null;
  prompt: string | null;
  filename: string | null;
}

const fresh = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

/** 给故事里的所有实体换新 id，返回新内容和 旧 id → 新 id 的映射（复制故事、导入故事包共用） */
export function remapStoryIds(data: StoryData): { data: StoryData; map: Map<string, string> } {
  const map = new Map<string, string>();
  const next = (old: string, prefix: string) => {
    const id = fresh(prefix);
    map.set(old, id);
    return id;
  };
  const copy = structuredClone(data);
  copy.characters = copy.characters.map((c) => ({ ...c, id: next(c.id, 'c_'), seriesShared: undefined }));
  copy.elements = (copy.elements ?? []).map((e) => ({ ...e, id: next(e.id, 'e_'), seriesShared: undefined }));
  for (const chapter of copy.chapters) {
    chapter.id = next(chapter.id, 'ch_');
    for (const scene of chapter.scenes) {
      scene.id = next(scene.id, 'sc_');
      for (const line of scene.dialogue) line.id = next(line.id, 'd_');
      for (const shot of scene.shots) shot.id = next(shot.id, 'sh_');
    }
  }
  const remap = (value: string | null | undefined) => (value ? (map.get(value) ?? value) : value);
  for (const chapter of copy.chapters) {
    for (const scene of chapter.scenes) {
      scene.locationId = remap(scene.locationId) ?? null;
      for (const line of scene.dialogue) line.characterId = remap(line.characterId) ?? null;
      for (const shot of scene.shots) {
        shot.characterIds = shot.characterIds.map((x) => remap(x)!);
        shot.elementIds = shot.elementIds?.map((x) => remap(x)!);
        shot.dialogueIds = shot.dialogueIds.map((x) => remap(x)!);
      }
    }
  }
  return { data: copy, map };
}

/** 故事引用到的所有素材 id */
function referencedAssets(storyId: string, data: StoryData): Set<string> {
  const ids = new Set<string>();
  const add = (id: string | null | undefined) => id && ids.add(id);
  for (const [, media] of effectiveMedia(storyId)) (add(media.keyframe), add(media.video));
  for (const c of data.characters) (add(c.referenceAssetId), c.refs?.forEach((r) => add(r.assetId)));
  for (const e of data.elements ?? []) e.refs?.forEach((r) => add(r.assetId));
  for (const chapter of data.chapters)
    for (const scene of chapter.scenes) {
      for (const line of scene.dialogue) add(line.voiceAssetId);
      for (const shot of scene.shots) (add(shot.keyframeAssetId), add(shot.videoAssetId), add(shot.firstFrame?.assetId));
    }
  // 角色定妆照的候选（挂在 char_ 伪镜头下）
  for (const row of db.prepare("SELECT id FROM assets WHERE story_id = ? AND shot_id LIKE 'char\\_%' ESCAPE '\\' AND deleted_at IS NULL").all(storyId) as Row[]) add(String(row.id));
  return ids;
}

export function packageEntries(storyId: string, userId: string): { title: string; entries: () => AsyncGenerator<ZipEntry> } {
  const { title, data } = loadStory(storyId);
  const ids = [...referencedAssets(storyId, data)];
  const rows = ids.length
    ? (db.prepare(`SELECT * FROM assets WHERE user_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).all(userId, ...ids) as Row[])
    : [];
  const assets: PackageAsset[] = rows.map((row) => ({
    id: String(row.id),
    path: `assets/${row.id}.${String(row.file).split('.').pop()}`,
    kind: row.kind as Asset['kind'],
    mime: String(row.mime),
    source: row.source as Asset['source'],
    purpose: (row.purpose as Asset['purpose']) ?? null,
    // 不是这个故事的素材（从资产库选的）导入后不挂到镜头下，只作为选定画面
    shotId: row.story_id === storyId ? ((row.shot_id as string | null) ?? null) : null,
    prompt: (row.prompt as string | null) ?? null,
    filename: (row.filename as string | null) ?? null,
  }));
  const files = new Map(rows.map((row) => [String(row.id), absoluteFile(String(row.file))]));
  async function* entries(): AsyncGenerator<ZipEntry> {
    yield { name: 'story.json', data: JSON.stringify({ format: PACKAGE_FORMAT, version: PACKAGE_VERSION, title, data, exportedAt: new Date().toISOString() }, null, 2) };
    yield { name: 'assets.json', data: JSON.stringify(assets, null, 2) };
    yield { name: 'AI标识说明.txt', data: `${AI_NOTICE}\n这是织影 Weave 的故事包，在"故事"页面点"导入故事包"即可还原。包内图片、视频、配音均为 AI 生成内容。\n` };
    for (const asset of assets) yield { name: asset.path, file: files.get(asset.id)! };
  }
  return { title, entries };
}

/** 导入故事包：返回新故事的 id 和导入的素材数 */
export interface ImportedPackage {
  title: string;
  data: StoryData;
  /** 存进来的素材，等故事建好后挂上 story_id 和新的 shot_id */
  assets: { id: string; shotId: string | null }[];
  skipped: number;
}

export async function importPackage(file: string, userId: string): Promise<ImportedPackage> {
  const index = await readZipIndex(file);
  const byName = new Map(index.map((entry) => [entry.name, entry]));
  const storyEntry = byName.get('story.json');
  if (!storyEntry) throw new Error('不是织影故事包：缺少 story.json');
  const manifest = JSON.parse((await readEntry(file, storyEntry)).toString('utf8')) as { format?: string; version?: number; title?: string; data?: StoryData };
  if (manifest.format !== PACKAGE_FORMAT || !manifest.data || !Array.isArray(manifest.data.chapters)) throw new Error('不是织影故事包');
  if ((manifest.version ?? 1) > PACKAGE_VERSION) throw new Error('故事包来自更新版本的织影，请先升级');
  const assetsEntry = byName.get('assets.json');
  const assets = assetsEntry ? (JSON.parse((await readEntry(file, assetsEntry)).toString('utf8')) as PackageAsset[]) : [];

  const { data, map } = remapStoryIds({ ...manifest.data, characters: manifest.data.characters ?? [], elements: manifest.data.elements ?? [] });
  const shotIdOf = (old: string | null) => {
    if (!old) return null;
    if (old.startsWith('char_')) {
      const character = map.get(old.slice(5));
      return character ? `char_${character}` : null;
    }
    return map.get(old) ?? null;
  };
  // 先把素材存进来（暂不挂故事，建好故事后再补 story_id）
  const assetMap = new Map<string, string>();
  const pending: { id: string; shotId: string | null }[] = [];
  let skipped = 0;
  for (const asset of assets.slice(0, 5000)) {
    const entry = byName.get(asset.path);
    if (!entry || !['image', 'video', 'audio'].includes(asset.kind) || !/^[a-z]+\/[\w.+-]+$/.test(asset.mime)) {
      skipped++;
      continue;
    }
    const temp = await newTempFile(asset.path.split('.').pop() || 'bin');
    try {
      await extractEntry(file, entry, temp);
      const saved = await saveAsset({
        userId,
        kind: asset.kind,
        source: asset.source === 'generated' ? 'generated' : 'upload',
        mime: asset.mime,
        filePath: temp,
        purpose: asset.purpose ?? null,
        prompt: asset.prompt,
        filename: asset.filename,
      });
      assetMap.set(asset.id, saved.id);
      pending.push({ id: saved.id, shotId: shotIdOf(asset.shotId) });
    } catch {
      await fs.rm(temp, { force: true });
      skipped++;
    }
  }
  const asset = (id: string | null | undefined) => (id ? (assetMap.get(id) ?? null) : null);
  for (const c of data.characters) {
    c.referenceAssetId = asset(c.referenceAssetId);
    c.refs = c.refs?.map((r) => ({ ...r, assetId: asset(r.assetId)! })).filter((r) => r.assetId);
  }
  for (const e of data.elements ?? []) e.refs = e.refs?.map((r) => ({ ...r, assetId: asset(r.assetId)! })).filter((r) => r.assetId);
  for (const chapter of data.chapters)
    for (const scene of chapter.scenes) {
      for (const line of scene.dialogue) line.voiceAssetId = asset(line.voiceAssetId);
      for (const shot of scene.shots) {
        shot.keyframeAssetId = asset(shot.keyframeAssetId);
        shot.videoAssetId = asset(shot.videoAssetId);
        if (shot.firstFrame?.assetId) shot.firstFrame = { ...shot.firstFrame, assetId: asset(shot.firstFrame.assetId) };
      }
    }
  return { title: String(manifest.title || '导入的故事').slice(0, 80), data, assets: pending, skipped };
}

export function attachImportedAssets(storyId: string, imported: ImportedPackage): void {
  const update = db.prepare('UPDATE assets SET story_id = ?, shot_id = ? WHERE id = ?');
  for (const item of imported.assets) update.run(storyId, item.shotId, item.id);
}
