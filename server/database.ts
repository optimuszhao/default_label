// 打开 SQLite 并设置运行参数（不执行迁移，CLI 工具也用它）。
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    -- WAL 下 NORMAL 已经足够安全（断电最多丢最后一个事务），写入快很多
    PRAGMA synchronous = NORMAL;
    -- 备份或另一个进程短暂占用时等待，而不是立刻报 database is locked
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);
  return db;
}
