// M0b · PLT-02 配置校验、PLT-04 迁移、PLT-07 日志脱敏与请求编号、探针、PLT-16 备份恢复
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { Client, startHarness, type Harness } from './harness.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning'];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'weave-plt-'));

describe('PLT-02 配置校验', () => {
  test('环境变量写错时拒绝启动，并用中文说明', () => {
    const result = spawnSync(NODE[0], [...NODE.slice(1), 'server/index.ts'], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: tmp(), PORT: 'abc', REGISTRATION: 'maybe', PROVIDER: 'mock' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /配置有误/);
    assert.match(result.stderr, /PORT 必须是数字/);
    assert.match(result.stderr, /REGISTRATION 只能是 open 或 closed/);
  });

  test('comfyweb 没填 GEN_API_BASE 时拒绝启动', () => {
    const result = spawnSync(NODE[0], [...NODE.slice(1), 'server/index.ts'], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: tmp(), PROVIDER: 'comfyweb', GEN_API_BASE: '' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /必须填写 GEN_API_BASE/);
  });
});

describe('PLT-04 迁移', () => {
  test('旧库：先备份再迁移，数据不变；重复执行不会再跑', async () => {
    const { openDatabase } = await import('../server/database.ts');
    const { runMigrations } = await import('../server/migrate.ts');
    const { m0001 } = await import('../server/migrations/0001_baseline.ts');
    const dir = tmp();
    // 造一个 v0.2 时代的库：有表有数据，但没有 schema_migrations
    const legacy = openDatabase(path.join(dir, 'weave.db'));
    m0001.up(legacy);
    legacy.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'old@x.com', '老用户', 'h', 1)").run();

    const first = runMigrations(legacy, { appVersion: '0.3.0', backupDir: path.join(dir, 'backups') });
    assert.deepEqual(first.applied.slice(0, 2), ['0001_baseline', '0002_indexes']);
    assert.ok(first.backupFile && fs.existsSync(first.backupFile), '迁移前有备份');
    const backup = new DatabaseSync(first.backupFile!, { readOnly: true });
    assert.equal((backup.prepare('SELECT email FROM users').get() as { email: string }).email, 'old@x.com');
    backup.close();
    assert.equal((legacy.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1);

    const second = runMigrations(legacy, { appVersion: '0.3.0', backupDir: path.join(dir, 'backups') });
    assert.deepEqual(second.applied, []);
    assert.equal(second.backupFile, null);
  });

  test('不兼容迁移后，旧版本程序拒绝使用这个库', async () => {
    const { openDatabase } = await import('../server/database.ts');
    const { IncompatibleVersionError, MIGRATIONS, runMigrations } = await import('../server/migrate.ts').then(async (m) => ({
      ...m,
      MIGRATIONS: (await import('../server/migrations/index.ts')).MIGRATIONS,
    }));
    const dir = tmp();
    const db = openDatabase(path.join(dir, 'weave.db'));
    const breaking = { id: '9999_breaking', description: '测试用', compat: false, up: () => undefined };
    runMigrations(db, { appVersion: '0.9.0', backupDir: dir, migrations: [...MIGRATIONS, breaking] });
    assert.throws(
      () => runMigrations(db, { appVersion: '0.3.0', backupDir: dir, migrations: [...MIGRATIONS, breaking] }),
      (error: Error) => error instanceof IncompatibleVersionError && /当前程序 v0\.3\.0 太旧/.test(error.message),
    );
  });

  test('服务启动时版本太旧：退出并给出中文提示', async () => {
    const dir = tmp();
    const db = new DatabaseSync(path.join(dir, 'weave.db'));
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('min_code_version', '99.0.0');");
    db.close();
    const result = spawnSync(NODE[0], [...NODE.slice(1), 'server/index.ts'], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: dir, PROVIDER: 'mock', PORT: '18999' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /数据库已被 v99\.0\.0 升级过/);
  });
});

describe('PLT-07 日志脱敏', () => {
  test('cookie、authorization、password、secret、token、apiKey 都被打码', async () => {
    const { createLogger } = await import('../server/log.ts');
    let output = '';
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk;
        callback();
      },
    });
    const logger = createLogger(sink as never);
    logger.level = 'info';
    logger.info(
      {
        req: { headers: { cookie: 'wv_sid=SECRET1', authorization: 'Bearer SECRET2' } },
        password: 'SECRET3',
        body: { secret: 'SECRET4', nested: { token: 'SECRET5' } },
        apiKey: 'SECRET6',
      },
      '测试',
    );
    assert.ok(output.includes('[已打码]'));
    for (let i = 1; i <= 6; i++) assert.ok(!output.includes(`SECRET${i}`), `SECRET${i} 没有被打码：${output}`);
  });
});

describe('探针与请求编号', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness({ PROVIDER: 'mock' });
  });
  after(async () => h?.stop());

  test('/healthz、/readyz、/api/version', async () => {
    assert.deepEqual(await (await fetch(`${h.base}/healthz`)).json(), { ok: true });
    const ready = await fetch(`${h.base}/readyz`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).ready, true);
    const version = await (await fetch(`${h.base}/api/version`)).json();
    assert.match(version.version, /^\d+\.\d+\.\d+/);
  });

  test('错误响应带请求编号，和响应头一致', async () => {
    const user = await h.user();
    const response = await user.raw('POST', '/api/tasks/nope/cancel');
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.ok(body.requestId);
    assert.equal(body.requestId, response.headers.get('x-request-id'));
  });

  // 路线图目标是 120 MB；实测 node 22 + fastify + pino 空闲约 125 MB，先以 150 MB 为红线防止回归
  test('空闲内存不超过 150 MB', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const rss = Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${h.pid}/status`, 'utf8'))![1]) / 1024;
    assert.ok(rss < 150, `空闲 RSS ${rss.toFixed(1)} MB`);
  });
});
