// 数据库每日备份：在 BACKUP_AT（默认 03:30，本地时间）执行
//   VACUUM INTO 临时文件 → integrity_check → gzip → 只保留最近 BACKUP_KEEP 份（默认 7）
// 备份放在 DATA_DIR/backups/，恢复用 scripts/restore.ts。
// 生成的图片视频（MEDIA_DIR）体积大，交给群晖快照 / Hyper Backup，见 README。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { config } from './config.ts';
import { db } from './db.ts';
import { logger } from './log.ts';

export interface BackupInfo {
  file: string;
  name: string;
  bytes: number;
  createdAt: number;
}

export function backupDir(): string {
  return path.join(config.dataDir, 'backups');
}

/** 下一次执行时间：今天的 HH:mm 还没到就是今天，否则明天 */
export function nextRunAt(now: Date, at: string): Date {
  const [hours, minutes] = at.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 列出每日备份（新的在前） */
export function listBackups(): BackupInfo[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^weave-\d{8}-\d{6}\.db\.gz$/.test(name))
    .sort()
    .reverse()
    .map((name) => {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      return { file, name, bytes: stat.size, createdAt: stat.mtimeMs };
    });
}

/** 检查一个 SQLite 文件是否完整 */
export function integrityOk(file: string): boolean {
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    const row = check.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    return row.integrity_check === 'ok';
  } finally {
    check.close();
  }
}

let running: Promise<BackupInfo> | null = null;

export function backupNow(now = new Date()): Promise<BackupInfo> {
  running ??= (async () => {
    const started = Date.now();
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const name = `weave-${stamp(now)}.db.gz`;
    const temp = path.join(dir, `.tmp-${stamp(now)}-${process.pid}.db`);
    const target = path.join(dir, name);
    try {
      // VACUUM INTO 生成一份一致的快照，不阻塞其他读写太久
      db.exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
      if (!integrityOk(temp)) throw new Error('备份文件完整性检查失败');
      await pipeline(fs.createReadStream(temp), zlib.createGzip({ level: 6 }), fs.createWriteStream(`${target}.partial`));
      fs.renameSync(`${target}.partial`, target);
    } finally {
      fs.rmSync(temp, { force: true });
      fs.rmSync(`${target}.partial`, { force: true });
    }
    // 只保留最近 N 份
    for (const old of listBackups().slice(config.backupKeep)) fs.rmSync(old.file, { force: true });
    const info = { file: target, name, bytes: fs.statSync(target).size, createdAt: Date.now() };
    logger.info({ backup: name, bytes: info.bytes, ms: Date.now() - started }, '数据库备份完成');
    return info;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** 按 BACKUP_AT 每天执行；返回停止函数 */
export function startBackups(): () => void {
  if (!config.backupAt) return () => undefined;
  let timer: NodeJS.Timeout;
  const schedule = () => {
    const delay = nextRunAt(new Date(), config.backupAt).getTime() - Date.now();
    timer = setTimeout(() => {
      backupNow()
        .catch((error) => logger.error({ err: error }, '数据库备份失败'))
        .finally(schedule);
    }, delay);
    timer.unref();
  };
  schedule();
  return () => clearTimeout(timer);
}
