// 数据库行 <-> 共享类型 的转换，以及常用查询。
import type { Asset, GenParams, Task, TaskInputs, User, UserSettings } from '../shared/types.ts';
import { db, parseJson, type Row } from './db.ts';

export function toUser(row: Row): User {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    isAdmin: row.role === 'admin',
    createdAt: Number(row.created_at),
  };
}

export function toSettings(row: Row): UserSettings {
  return {
    autoDispatch: Number(row.auto_dispatch) === 1,
    pollIntervalSec: Number(row.poll_interval_sec),
  };
}

export function assetUrl(id: string): string {
  return `/api/files/${id}`;
}

export function toAsset(row: Row, tags: string[] = []): Asset {
  const id = String(row.id);
  const url = assetUrl(id);
  return {
    id,
    kind: row.kind as Asset['kind'],
    source: row.source as Asset['source'],
    mime: String(row.mime),
    url,
    // 有缩略图时网格只加载缩略图（几十 KB），没有时退回原文件
    thumbUrl: row.thumb ? `${url}?variant=thumb` : url,
    posterUrl: row.poster ? `${url}?variant=poster` : null,
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    prompt: (row.prompt as string | null) ?? null,
    taskId: (row.task_id as string | null) ?? null,
    storyId: (row.story_id as string | null) ?? null,
    shotId: (row.shot_id as string | null) ?? null,
    purpose: (row.purpose as Asset['purpose']) ?? null,
    duration: row.duration == null ? null : Number(row.duration),
    gen: parseJson<Asset['gen']>(row.gen, null),
    parentAssetId: (row.parent_asset_id as string | null) ?? null,
    lineage: (row.lineage as Asset['lineage']) ?? (row.parent_asset_id ? 'derive' : null),
    favorite: Number(row.favorite) === 1,
    size: row.size == null ? null : Number(row.size),
    rating: Number(row.rating ?? 0),
    flag: (row.flag as Asset['flag']) ?? null,
    note: String(row.note ?? ''),
    folderId: (row.folder_id as string | null) ?? null,
    tags,
    filename: (row.filename as string | null) ?? null,
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
    createdAt: Number(row.created_at),
  };
}

/** 一批资产的标签名（列表接口一次查完，避免逐条查询） */
export function tagsFor(assetIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (assetIds.length === 0) return map;
  for (let i = 0; i < assetIds.length; i += 500) {
    const chunk = assetIds.slice(i, i + 500);
    const rows = db
      .prepare(`SELECT at.asset_id, t.name FROM asset_tags at JOIN tags t ON t.id = at.tag_id WHERE at.asset_id IN (${chunk.map(() => '?').join(',')}) ORDER BY t.name`)
      .all(...chunk) as Row[];
    for (const row of rows) {
      const list = map.get(String(row.asset_id)) ?? [];
      list.push(String(row.name));
      map.set(String(row.asset_id), list);
    }
  }
  return map;
}

/** 行转资产并带上标签 */
export function toAssets(rows: Row[]): Asset[] {
  const tags = tagsFor(rows.map((row) => String(row.id)));
  return rows.map((row) => toAsset(row, tags.get(String(row.id)) ?? []));
}

export function loadAsset(id: string): Asset | null {
  const row = getAssetRow(id);
  return row ? toAsset(row, tagsFor([id]).get(id) ?? []) : null;
}

export function toTask(row: Row): Task {
  return {
    id: String(row.id),
    type: row.type as Task['type'],
    status: row.status as Task['status'],
    title: String(row.title),
    prompt: String(row.prompt),
    negativePrompt: String(row.negative_prompt ?? ''),
    params: parseJson<GenParams>(row.params, {} as GenParams),
    inputs: parseJson<TaskInputs>(row.inputs, {}),
    link: {
      storyId: (row.story_id as string | null) ?? null,
      shotId: (row.shot_id as string | null) ?? null,
      purpose: (row.purpose as Task['link']['purpose']) ?? null,
    },
    progress: Number(row.progress),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    priority: Number(row.priority),
    lastError: (row.last_error as string | null) ?? null,
    waitReason: (row.wait_reason as string | null) ?? null,
    stage: (row.stage as string | null) ?? null,
    nextAttemptAt: Number(row.next_attempt_at),
    manualKick: Number(row.manual_kick) === 1,
    outputAssetIds: parseJson<string[]>(row.output_asset_ids, []),
    recipe: parseJson<Task['recipe']>(row.recipe, null),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
  };
}

const getTaskStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
export function getTask(id: string): Task | null {
  const row = getTaskStmt.get(id) as Row | undefined;
  return row ? toTask(row) : null;
}

export function getTaskOwner(id: string): string | null {
  const row = db.prepare('SELECT user_id FROM tasks WHERE id = ?').get(id) as Row | undefined;
  return row ? String(row.user_id) : null;
}

export function getAssetRow(id: string): Row | null {
  return (db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Row | undefined) ?? null;
}

export function getUserSettings(userId: string): UserSettings {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Row;
  return toSettings(row);
}
