// 0001 基线：v0.2.0 时的完整表结构。
// 对 v0.2.0 及更早的库也安全：建表都用 IF NOT EXISTS，补列前先检查。
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../migrate.ts';

function addColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const m0001: Migration = {
  id: '0001_baseline',
  description: '基线表结构（v0.2.0）',
  compat: true,
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  auto_dispatch INTEGER NOT NULL DEFAULT 1,
  poll_interval_sec INTEGER NOT NULL DEFAULT 30,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  negative_prompt TEXT NOT NULL DEFAULT '',
  params TEXT NOT NULL,
  inputs TEXT NOT NULL,
  story_id TEXT,
  shot_id TEXT,
  purpose TEXT,
  progress REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  wait_reason TEXT,
  stage TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  manual_kick INTEGER NOT NULL DEFAULT 0,
  provider_job_id TEXT,
  output_asset_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  mime TEXT NOT NULL,
  file TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  prompt TEXT,
  task_id TEXT,
  story_id TEXT,
  shot_id TEXT,
  purpose TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_story ON assets(story_id, shot_id);
`);
    // v0.1 → v0.2 期间陆续加的列
    addColumn(db, 'tasks', 'stage', 'TEXT');
    addColumn(db, 'tasks', 'run_seed', 'INTEGER');
    addColumn(db, 'assets', 'gen', 'TEXT');
    addColumn(db, 'assets', 'duration', 'REAL');
    addColumn(db, 'stories', 'rev', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`
CREATE TABLE IF NOT EXISTS story_snapshots (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_story_snapshots ON story_snapshots(story_id, created_at DESC);
`);
  },
};
