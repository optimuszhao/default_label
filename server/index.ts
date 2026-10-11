// 入口：执行迁移（导入 db.ts 时）→ 组装应用 → 监听端口 → 启动调度器
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.ts';
import { purgeExpiredSessions } from './auth.ts';
import { startBackups } from './backup.ts';
import { config } from './config.ts';
import { cleanTempDir } from './files.ts';
import { startJobs } from './jobs/runner.ts';
import { startLibraryBackfill } from './library/derive.ts';
import { startStoryMigration } from './stories/migrate.ts';
import { logger } from './log.ts';
import { startScheduler } from './scheduler.ts';

const app = await buildApp();

await cleanTempDir();
const stopScheduler = startScheduler();
const stopJobs = startJobs();
startLibraryBackfill();
startStoryMigration();
const stopBackups = startBackups();
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 3600 * 1000).unref();

await app.listen({ port: config.port, host: config.host });

// 心跳文件：scripts/restore.ts 据此判断服务是否还在运行（跨容器也有效）
const heartbeat = path.join(config.dataDir, '.running');
const beat = () => fs.writeFileSync(heartbeat, JSON.stringify({ pid: process.pid, version: config.appVersion, at: Date.now() }));
beat();
setInterval(beat, 30_000).unref();
logger.info({ port: config.port, provider: config.provider, version: config.appVersion }, `织影已启动 http://localhost:${config.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopScheduler();
    stopJobs();
    stopBackups();
    await app.close();
    fs.rmSync(heartbeat, { force: true });
    process.exit(0);
  });
}
