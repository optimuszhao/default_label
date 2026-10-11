// 标签：按名字建、按名字挂，名字在同一个用户下唯一
import { db, newId, now, type Row } from '../db.ts';
import { indexAsset } from '../files.ts';

export function normalizeTag(name: string): string {
  return name.trim().replace(/^#/, '').replace(/\s+/g, ' ').slice(0, 30);
}

export function ensureTags(userId: string, names: string[]): string[] {
  const ids: string[] = [];
  for (const raw of names) {
    const name = normalizeTag(raw);
    if (!name) continue;
    const row = db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ?').get(userId, name) as Row | undefined;
    if (row) ids.push(String(row.id));
    else {
      const id = newId('tg_');
      db.prepare('INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, userId, name, now());
      ids.push(id);
    }
  }
  return [...new Set(ids)];
}

export function addTags(userId: string, assetIds: string[], names: string[]): void {
  const tagIds = ensureTags(userId, names);
  const insert = db.prepare('INSERT OR IGNORE INTO asset_tags (asset_id, tag_id) VALUES (?, ?)');
  for (const assetId of assetIds) for (const tagId of tagIds) insert.run(assetId, tagId);
  indexAsset(...assetIds);
}

export function removeTags(userId: string, assetIds: string[], names: string[]): void {
  const tagIds = names
    .map((name) => db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ?').get(userId, normalizeTag(name)) as Row | undefined)
    .filter(Boolean)
    .map((row) => String(row!.id));
  const remove = db.prepare('DELETE FROM asset_tags WHERE asset_id = ? AND tag_id = ?');
  for (const assetId of assetIds) for (const tagId of tagIds) remove.run(assetId, tagId);
  indexAsset(...assetIds);
}

/** 把一个素材的标签整体替换成给定的这组 */
export function setTags(userId: string, assetId: string, names: string[]): void {
  const tagIds = ensureTags(userId, names);
  db.prepare('DELETE FROM asset_tags WHERE asset_id = ?').run(assetId);
  const insert = db.prepare('INSERT OR IGNORE INTO asset_tags (asset_id, tag_id) VALUES (?, ?)');
  for (const tagId of tagIds) insert.run(assetId, tagId);
  indexAsset(assetId);
}
