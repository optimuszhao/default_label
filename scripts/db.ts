// 数据库迁移命令行：
//   npm run db -- status     查看已执行 / 待执行的迁移
//   npm run db -- dry-run    只列出将要执行的迁移，不改动数据库
//   npm run db -- migrate    执行迁移（服务启动时也会自动执行）
// 容器里：docker compose run --rm weave node scripts/db.ts status
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../server/database.ts';
import { migrationStatus, runMigrations } from '../server/migrate.ts';

const dataDir = path.resolve(process.env.DATA_DIR?.trim() || 'data');
const file = path.join(dataDir, 'weave.db');
const command = process.argv[2] ?? 'status';
const version = (JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string }).version;

if (!fs.existsSync(file) && command !== 'migrate') {
  console.log(`${file} 还不存在，第一次启动服务时会自动创建。`);
  process.exit(0);
}
fs.mkdirSync(dataDir, { recursive: true });
const db = openDatabase(file);

if (command === 'status' || command === 'dry-run') {
  const status = migrationStatus(db);
  console.log(`数据库：${file}`);
  console.log(`程序版本：v${version}${status.minCodeVersion ? `；数据库要求程序版本 ≥ v${status.minCodeVersion}` : ''}`);
  console.log('\n已执行：');
  for (const row of status.applied) console.log(`  ✔ ${row.id}  (v${row.app_version}, ${new Date(row.applied_at).toLocaleString('zh-CN')})`);
  if (!status.applied.length) console.log('  （无）');
  console.log(command === 'dry-run' ? '\n将要执行：' : '\n待执行：');
  for (const m of status.pending) console.log(`  · ${m.id}  ${m.description}${m.compat ? '' : '（不兼容旧版本）'}`);
  if (!status.pending.length) console.log('  （无）');
  for (const warning of status.checksumWarnings) console.log(`\n⚠ ${warning}`);
} else if (command === 'migrate') {
  const result = runMigrations(db, { appVersion: version, backupDir: path.join(dataDir, 'backups') });
  console.log(result.applied.length ? `✔ 已执行 ${result.applied.join('、')}` : '没有待执行的迁移');
} else {
  console.error('用法：node scripts/db.ts status | dry-run | migrate');
  process.exit(1);
}
