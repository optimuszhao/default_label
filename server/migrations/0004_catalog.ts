// 0004：预设、提示词模板、收藏、我的提示词、模板使用记录；任务配方和资产谱系。只加表和列。
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../migrate.ts';

function addColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const m0004: Migration = {
  id: '0004_catalog',
  description: '预设、提示词模板、收藏、我的提示词、配方与谱系',
  compat: true,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS presets (
        slug TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        grp TEXT NOT NULL DEFAULT '',
        position TEXT NOT NULL DEFAULT 'suffix',
        applies TEXT NOT NULL DEFAULT 'both',
        prompt TEXT NOT NULL DEFAULT '',
        negative TEXT,
        fallback_prompt TEXT,
        params TEXT NOT NULL DEFAULT '{}',
        cover TEXT,
        hint TEXT,
        sort INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        customized INTEGER NOT NULL DEFAULT 0,
        seed_version INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prompt_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL,
        body TEXT NOT NULL,
        variables TEXT NOT NULL DEFAULT '[]',
        negative TEXT NOT NULL DEFAULT '',
        presets TEXT NOT NULL DEFAULT '[]',
        params TEXT NOT NULL DEFAULT '{}',
        requires_reference INTEGER NOT NULL DEFAULT 0,
        featured INTEGER NOT NULL DEFAULT 0,
        cover TEXT,
        sort INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        customized INTEGER NOT NULL DEFAULT 0,
        seed_version INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS favorites (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, kind, ref)
      );

      CREATE TABLE IF NOT EXISTS user_prompts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_prompts ON user_prompts(user_id, created_at DESC);

      -- 同一个人同一天用同一个模板只记 1 次（热门分用）
      CREATE TABLE IF NOT EXISTS template_usage (
        template_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        day TEXT NOT NULL,
        PRIMARY KEY (template_id, user_id, day)
      );
    `);
    addColumn(db, 'tasks', 'recipe', 'TEXT');
    addColumn(db, 'assets', 'parent_asset_id', 'TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assets_parent ON assets(parent_asset_id)');
  },
};
