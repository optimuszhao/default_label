// M0b · PLT-16 备份与恢复（单独一个文件：需要在本进程里以临时数据目录加载服务端模块）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { Client, startHarness } from './harness.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning'];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'weave-plt-'));

describe('PLT-16 备份与恢复', () => {
  test('每天 03:30 的排期、完整性检查、只保留 7 份、restore 恢复后服务正常', async () => {
    const dir = tmp();
    // 用一个真实服务建库并注册用户，然后停掉
    const first = await startHarness({ PROVIDER: 'mock', DATA_DIR: dir });
    await first.user('keep@test.local');
    await first.stop({ keepData: true });

    // 在本进程里加载备份模块（指向同一个数据目录）
    process.env.DATA_DIR = dir;
    process.env.PROVIDER = 'mock';
    process.env.BACKUP_KEEP = '7';
    const { backupNow, listBackups, nextRunAt, integrityOk } = await import('../server/backup.ts');
    const { db } = await import('../server/db.ts');

    assert.equal(nextRunAt(new Date(2026, 9, 10, 3, 29), '03:30').getTime(), new Date(2026, 9, 10, 3, 30).getTime());
    assert.equal(nextRunAt(new Date(2026, 9, 10, 3, 30), '03:30').getTime(), new Date(2026, 9, 11, 3, 30).getTime());

    for (let day = 1; day <= 9; day++) await backupNow(new Date(2026, 9, day, 3, 30));
    const backups = listBackups();
    assert.equal(backups.length, 7);
    assert.equal(backups[0].name, 'weave-20261009-033000.db.gz');
    assert.equal(backups.at(-1)!.name, 'weave-20261003-033000.db.gz');

    // 备份之后再写入的数据，恢复后应当消失
    db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u_late', 'late@test.local', 'late', 'h', 1)").run();
    const restore = spawnSync(NODE[0], [...NODE.slice(1), 'scripts/restore.ts', backups[0].name], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: dir },
      encoding: 'utf8',
    });
    assert.equal(restore.status, 0, restore.stderr);
    assert.match(restore.stdout, /已从 weave-20261009-033000\.db\.gz 恢复/);
    assert.ok(integrityOk(path.join(dir, 'weave.db')));
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('weave.db.before-restore-')));

    const second = await startHarness({ PROVIDER: 'mock', DATA_DIR: dir });
    try {
      const client = new Client(second.base);
      await client.post('/api/auth/login', { email: 'keep@test.local', password: 'password123' });
      assert.equal((await client.get('/api/auth/me')).user.email, 'keep@test.local');
      const late = await new Client(second.base).raw('POST', '/api/auth/login', { email: 'late@test.local', password: 'x12345' });
      assert.equal(late.status, 401);
    } finally {
      await second.stop();
    }
  });
});
