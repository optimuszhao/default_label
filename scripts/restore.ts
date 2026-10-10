// 从备份恢复数据库。先停掉织影服务再运行：
//
//   docker compose stop weave
//   docker compose run --rm weave node scripts/restore.ts                # 列出可用备份
//   docker compose run --rm weave node scripts/restore.ts <备份文件名>    # 恢复指定备份
//   docker compose start weave
//
// 本地开发：npm run restore -- [备份文件名]
// 当前数据库不会被删除，会改名为 weave.db.before-restore-<时间>，恢复错了可以换回来。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

const dataDir = path.resolve(process.env.DATA_DIR?.trim() || 'data');
const dbFile = path.join(dataDir, 'weave.db');
const backupDir = path.join(dataDir, 'backups');

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function list(): string[] {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((name) => /\.db(\.gz)?$/.test(name) && !name.startsWith('.'))
    .sort()
    .reverse();
}

const arg = process.argv[2];
if (!arg) {
  const items = list();
  if (!items.length) fail(`${backupDir} 下没有备份`);
  console.log(`可用备份（${backupDir}）：`);
  for (const name of items) {
    const { size, mtime } = fs.statSync(path.join(backupDir, name));
    console.log(`  ${name}  ${(size / 1024 / 1024).toFixed(2)} MB  ${mtime.toLocaleString('zh-CN')}`);
  }
  console.log('\n恢复：node scripts/restore.ts <备份文件名>');
  process.exit(0);
}

const source = fs.existsSync(arg) ? path.resolve(arg) : path.join(backupDir, arg);
if (!fs.existsSync(source)) fail(`找不到备份文件：${arg}`);

// 服务运行时每 30 秒写一次心跳文件，90 秒内有心跳就认为还在运行
const heartbeat = path.join(dataDir, '.running');
if (fs.existsSync(heartbeat) && Date.now() - fs.statSync(heartbeat).mtimeMs < 90_000 && !process.argv.includes('--force')) {
  fail('织影服务似乎还在运行，请先停止（docker compose stop weave）再恢复。确认已停止仍提示时加 --force');
}

const restoring = `${dbFile}.restoring`;
fs.rmSync(restoring, { force: true });
if (source.endsWith('.gz')) {
  await pipeline(fs.createReadStream(source), zlib.createGunzip(), fs.createWriteStream(restoring));
} else {
  fs.copyFileSync(source, restoring);
}

const check = new DatabaseSync(restoring, { readOnly: true });
const result = (check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
check.close();
if (result !== 'ok') {
  fs.rmSync(restoring, { force: true });
  fail(`备份文件损坏（integrity_check: ${result}），没有做任何改动`);
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
if (fs.existsSync(dbFile)) {
  const keep = `${dbFile}.before-restore-${stamp}`;
  fs.renameSync(dbFile, keep);
  console.log(`当前数据库已改名为 ${path.basename(keep)}`);
}
for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbFile}${suffix}`, { force: true });
fs.renameSync(restoring, dbFile);
console.log(`✔ 已从 ${path.basename(source)} 恢复，启动织影服务即可。`);
