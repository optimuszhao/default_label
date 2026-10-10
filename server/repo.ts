// 数据库行 <-> 共享类型 的转换，以及常用查询。
import type { Asset, GenParams, Task, TaskInputs, User, UserSettings } from '../shared/types.ts';
import { db, parseJson, type Row } from './db.ts';

export function toUser(row: Row): User {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
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

export function toAsset(row: Row): Asset {
  const id = String(row.id);
  return {
    id,
    kind: row.kind as Asset['kind'],
    source: row.source as Asset['source'],
    mime: String(row.mime),
    url: assetUrl(id),
    thumbUrl: assetUrl(id),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    prompt: (row.prompt as string | null) ?? null,
    taskId: (row.task_id as string | null) ?? null,
    storyId: (row.story_id as string | null) ?? null,
    shotId: (row.shot_id as string | null) ?? null,
    purpose: (row.purpose as Asset['purpose']) ?? null,
    favorite: Number(row.favorite) === 1,
    createdAt: Number(row.created_at),
  };
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
    nextAttemptAt: Number(row.next_attempt_at),
    manualKick: Number(row.manual_kick) === 1,
    outputAssetIds: parseJson<string[]>(row.output_asset_ids, []),
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
