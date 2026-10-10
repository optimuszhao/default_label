import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { openDatabase } from './database.ts';
import { runMigrations } from './migrate.ts';

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.mediaDir, { recursive: true });

export const db = openDatabase(path.join(config.dataDir, 'weave.db'));

// 启动时先执行迁移，之后其他模块才能安全地准备 SQL 语句
export const migration = (() => {
  try {
    return runMigrations(db, { appVersion: config.appVersion, backupDir: path.join(config.dataDir, 'backups') });
  } catch (error) {
    console.error(`[weave] ${(error as Error).message}`);
    process.exit(1);
  }
})();

export function newId(prefix = ''): string {
  return prefix + randomBytes(9).toString('base64url');
}

export function now(): number {
  return Date.now();
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export type Row = Record<string, unknown>;
