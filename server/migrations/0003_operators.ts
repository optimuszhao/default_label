// 0003：算子表、加密凭证、审计日志、用户角色。只加表和列，旧版本程序仍可使用这个库。
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../migrate.ts';

function addColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const m0003: Migration = {
  id: '0003_operators',
  description: '算子、加密凭证、审计日志、用户角色',
  compat: true,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS operators (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        base_url TEXT NOT NULL DEFAULT '',
        appid TEXT NOT NULL DEFAULT '',
        settings TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        maintenance INTEGER NOT NULL DEFAULT 0,
        maintenance_note TEXT,
        visibility TEXT NOT NULL DEFAULT 'all',
        priority INTEGER NOT NULL DEFAULT 0,
        max_inflight INTEGER NOT NULL DEFAULT 2,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- 加密保存的密钥与令牌（scope 如 operator:<id>，key 如 secret / token）
      CREATE TABLE IF NOT EXISTS secrets (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        actor_id TEXT,
        actor_email TEXT,
        action TEXT NOT NULL,
        target TEXT,
        summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at DESC);
    `);
    addColumn(db, 'users', 'role', "TEXT NOT NULL DEFAULT 'user'");
    addColumn(db, 'users', 'disabled_at', 'INTEGER');
    addColumn(db, 'users', 'last_login_at', 'INTEGER');
    addColumn(db, 'tasks', 'operator_id', 'TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_operator ON tasks(operator_id, status)');
  },
};
