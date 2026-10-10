// 数据库迁移：
// - 每个迁移只执行一次，记录在 schema_migrations（含校验和、执行时的程序版本）
// - 有待执行的迁移且库里已有数据时，先用 VACUUM INTO 备份一份
// - 每个迁移一个事务，失败整体回滚，服务不启动
// - compat=false 的迁移会把 min_code_version 提到当前版本：之后旧版本程序拒绝启动，避免用旧代码写坏新结构
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations/index.ts';

export interface Migration {
  id: string;
  description: string;
  /** 迁移后旧版本程序是否还能正常使用这个库（只加表、加列、加索引时为 true） */
  compat: boolean;
  up(db: DatabaseSync): void;
}

export interface MigrationResult {
  applied: string[];
  pending: string[];
  backupFile: string | null;
  minCodeVersion: string | null;
  checksumWarnings: string[];
}

export class IncompatibleVersionError extends Error {}

/** 比较 x.y.z 版本号 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

export function checksum(migration: Migration): string {
  return createHash('sha256').update(migration.up.toString()).digest('hex').slice(0, 16);
}

function ensureMetaTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      app_version TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function hasUserData(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() as { n: number };
  return Number(row.n) > 0;
}

/** 当前状态：已执行、待执行、校验和不一致 */
export function migrationStatus(db: DatabaseSync, migrations: Migration[] = MIGRATIONS) {
  ensureMetaTables(db);
  const rows = db.prepare('SELECT id, checksum, app_version, applied_at FROM schema_migrations ORDER BY id').all() as {
    id: string;
    checksum: string;
    app_version: string;
    applied_at: number;
  }[];
  const applied = new Map(rows.map((row) => [row.id, row]));
  return {
    applied: rows,
    pending: migrations.filter((m) => !applied.has(m.id)),
    checksumWarnings: migrations
      .filter((m) => applied.has(m.id) && applied.get(m.id)!.checksum !== checksum(m))
      .map((m) => `迁移 ${m.id} 在执行后被修改过（校验和不一致），请确认没有改动已发布的迁移`),
    minCodeVersion: getMeta(db, 'min_code_version'),
  };
}

export function runMigrations(
  db: DatabaseSync,
  options: { appVersion: string; backupDir: string; migrations?: Migration[]; dryRun?: boolean },
): MigrationResult {
  const migrations = options.migrations ?? MIGRATIONS;
  const status = migrationStatus(db, migrations);

  if (status.minCodeVersion && compareVersions(options.appVersion, status.minCodeVersion) < 0) {
    throw new IncompatibleVersionError(
      `数据库已被 v${status.minCodeVersion} 升级过，当前程序 v${options.appVersion} 太旧，不能使用这个库。` +
        `请改用 v${status.minCodeVersion} 或更新的镜像；如果确实要回退，请先用 scripts/restore.ts 恢复升级前的备份（会丢失升级之后产生的数据）。`,
    );
  }
  for (const warning of status.checksumWarnings) console.warn(`[migrate] ${warning}`);

  const result: MigrationResult = {
    applied: [],
    pending: status.pending.map((m) => m.id),
    backupFile: null,
    minCodeVersion: status.minCodeVersion,
    checksumWarnings: status.checksumWarnings,
  };
  if (!status.pending.length || options.dryRun) return result;

  // 已有数据的库先备份，迁移出问题可以恢复
  if (hasUserData(db)) {
    fs.mkdirSync(options.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    const file = path.join(options.backupDir, `pre-migrate-${status.pending[0].id}-${stamp}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    result.backupFile = file;
    console.info(`[migrate] 迁移前已备份到 ${file}`);
  }

  for (const migration of status.pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id, checksum, app_version, applied_at) VALUES (?, ?, ?, ?)').run(
        migration.id,
        checksum(migration),
        options.appVersion,
        Date.now(),
      );
      if (!migration.compat) {
        setMeta(db, 'min_code_version', options.appVersion);
        result.minCodeVersion = options.appVersion;
      }
      db.exec('COMMIT');
      result.applied.push(migration.id);
      console.info(`[migrate] 已执行 ${migration.id}：${migration.description}`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`数据库迁移 ${migration.id} 失败，已回滚：${(error as Error).message}`);
    }
  }
  return result;
}
