// M1 · 超管后台：角色、算子管理、令牌、路由、审计（以及 M0a 的注册开关）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { IMAGE_PARAMS, Client, startHarness, until, type Harness } from './harness.ts';

const ADMIN = 'boss@test.local';

describe('角色与入口', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness({ ADMIN_EMAILS: `Other@x.com, ${ADMIN.toUpperCase()}` });
  });
  after(async () => h?.stop());

  test('ADMIN_EMAILS 里的账号是超管；普通用户和未登录访问管理接口一律 404', async () => {
    const admin = await h.user(ADMIN);
    assert.equal((await admin.get('/api/auth/me')).user.isAdmin, true);
    const normal = await h.user();
    assert.equal((await normal.get('/api/auth/me')).user.isAdmin, false);
    for (const url of ['/api/admin/overview', '/api/admin/operators', '/api/admin/users']) {
      assert.equal((await normal.raw('GET', url)).status, 404);
      assert.equal((await fetch(`${h.base}${url}`)).status, 404);
    }
  });

  test('首次启动从环境变量导入默认算子，并能正常出图', async () => {
    const admin = new Client(h.base);
    await admin.post('/api/auth/login', { email: ADMIN, password: 'password123' });
    const operators = await admin.get<any[]>('/api/admin/operators');
    assert.equal(operators.length, 1);
    assert.equal(operators[0].id, 'op_default');
    assert.equal(operators[0].kind, 'comfyweb');
    assert.equal(operators[0].appid, 'dev');
    assert.equal(operators[0].secret.set, true);
    const t = await admin.post('/api/tasks', { type: 't2i', prompt: '默认算子', params: IMAGE_PARAMS });
    const done = await until(async () => {
      const x = (await admin.get<any[]>('/api/tasks')).find((y) => y.id === t.id);
      return x?.status === 'succeeded' ? x : null;
    }, 15_000, '出图');
    assert.equal(done.outputAssetIds.length, 1);
  });

  test('至少保留一位超管；停用账号后无法登录', async () => {
    const admin = new Client(h.base);
    await admin.post('/api/auth/login', { email: ADMIN, password: 'password123' });
    const users = await admin.get<any[]>('/api/admin/users');
    const me = users.find((u) => u.email === ADMIN);
    const demote = await admin.raw('PATCH', `/api/admin/users/${me.id}`, { role: 'user' });
    assert.equal(demote.status, 409);
    const victim = await h.user('victim@test.local');
    const victimId = (await victim.get('/api/auth/me')).user.id;
    await admin.patch(`/api/admin/users/${victimId}`, { disabled: true });
    assert.equal((await victim.get('/api/auth/me')).user, null, '会话立即失效');
    const login = await new Client(h.base).raw('POST', '/api/auth/login', { email: 'victim@test.local', password: 'password123' });
    assert.equal(login.status, 403);
  });
});

describe('算子管理与令牌', () => {
  let h: Harness;
  let admin: Client;
  before(async () => {
    h = await startHarness({ ADMIN_EMAILS: ADMIN });
    admin = await h.user(ADMIN);
  });
  after(async () => h?.stop());

  const draft = () => ({ name: '第二台', kind: 'comfyweb', baseUrl: h.operator, appid: 'dev', secret: 'dev' });

  test('新建前测试连接：网络、换取令牌、校验、能力、远端队列、试跑', async () => {
    const steps = await admin.post<any[]>('/api/admin/operators/test', { ...draft(), generate: true });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    for (const key of ['network', 'login', 'verify', 'capabilities', 'remote', 'generate']) assert.equal(byKey[key].ok, true, `${key}: ${byKey[key]?.message}`);
    assert.match(byKey.login.message, /按文档 72 小时推算/);
    assert.match(byKey.preview.message, /^data:image\/png;base64,/);
    const bad = await admin.post<any[]>('/api/admin/operators/test', { ...draft(), secret: 'wrong' });
    assert.equal(bad.find((s) => s.key === 'login').ok, false);
    assert.match(bad.find((s) => s.key === 'login').message, /appid 或 secret 错误/);
  });

  test('保存、令牌卡片、重新获取 / 校验 / 查看明文都写审计；数据库里没有明文密钥', async () => {
    const created = await admin.post('/api/admin/operators', { ...draft(), secret: 'super-secret-xyz-123' });
    assert.equal(created.secret.set, true);
    // 密钥错误时换取失败
    const failed = await admin.post(`/api/admin/operators/${created.id}/token/renew`);
    assert.equal(failed.hasToken, false);
    await admin.patch(`/api/admin/operators/${created.id}`, { secret: 'dev' });
    const renewed = await admin.post(`/api/admin/operators/${created.id}/token/renew`);
    assert.equal(renewed.hasToken, true);
    assert.equal(renewed.lastVerifyOk, true);
    assert.equal(Math.round((renewed.expiresAt - renewed.issuedAt) / 3600_000), 72);
    const verified = await admin.post(`/api/admin/operators/${created.id}/token/verify`);
    assert.equal(verified.lastVerifyOk, true);
    const revealed = await admin.post(`/api/admin/operators/${created.id}/token/reveal`);
    assert.match(revealed.token, /^fake\./);

    const actions = (await admin.get<any[]>('/api/admin/audit')).map((a) => a.action);
    for (const action of ['operator.create', 'operator.update', 'token.renew', 'token.verify', 'token.reveal']) assert.ok(actions.includes(action), action);

    const bytes = fs.readFileSync(path.join(h.dataDir, 'weave.db'));
    const wal = fs.existsSync(path.join(h.dataDir, 'weave.db-wal')) ? fs.readFileSync(path.join(h.dataDir, 'weave.db-wal')) : Buffer.alloc(0);
    for (const blob of [bytes, wal]) {
      assert.ok(!blob.includes('super-secret-xyz-123'), '密钥是明文');
      assert.ok(!blob.includes(revealed.token), '令牌是明文');
    }
    await admin.json('DELETE', `/api/admin/operators/${created.id}`);
  });

  test('仅管理员可见的算子不接收普通用户的任务；维护模式不派发', async () => {
    await admin.patch('/api/admin/operators/op_default', { maintenance: true, maintenanceNote: '换显卡' });
    const privateOp = await admin.post('/api/admin/operators', { name: '管理员专用', kind: 'mock', baseUrl: '', visibility: 'admin_only' });
    const normal = await h.user();
    const t1 = await normal.post('/api/tasks', { type: 't2i', prompt: '普通用户', params: IMAGE_PARAMS });
    const waiting = await until(async () => {
      const x = (await normal.get<any[]>('/api/tasks')).find((y) => y.id === t1.id);
      return x?.waitReason ? x : null;
    }, 8_000, '普通用户进入等待');
    assert.doesNotMatch(waiting.waitReason, /http|127\.0\.0\.1/, '不暴露算子地址');
    const health = await normal.get('/api/health');
    assert.equal(health.image, false);
    assert.match(health.message, /维护中：换显卡/);

    const t2 = await admin.post('/api/tasks', { type: 't2i', prompt: '管理员', params: IMAGE_PARAMS });
    const done = await until(async () => {
      const x = (await admin.get<any[]>('/api/tasks')).find((y) => y.id === t2.id);
      return x?.status === 'succeeded' ? x : null;
    }, 20_000, '管理员任务完成');
    const tasks = await admin.get<any[]>('/api/admin/tasks?q=管理员');
    assert.equal(tasks.find((x) => x.id === done.id).operatorName, '管理员专用');

    await admin.patch('/api/admin/operators/op_default', { maintenance: false });
    await admin.json('DELETE', `/api/admin/operators/${privateOp.id}`);
  });

  test('令牌加密保存，重启后直接恢复，不重新登录', async () => {
    const before = await admin.post('/api/admin/operators/op_default/token/renew');
    assert.equal(before.hasToken, true);
    await h.stop({ keepData: true });
    const db = new DatabaseSync(path.join(h.dataDir, 'weave.db'), { readOnly: true });
    const row = db.prepare("SELECT ciphertext FROM secrets WHERE scope = 'operator:op_default' AND key = 'token'").get() as { ciphertext: string };
    db.close();
    assert.match(row.ciphertext, /^v1\./);

    h = await startHarness({ ADMIN_EMAILS: ADMIN, DATA_DIR: h.dataDir });
    admin = new Client(h.base);
    await admin.post('/api/auth/login', { email: ADMIN, password: 'password123' });
    const after = await admin.get('/api/admin/operators/op_default/token');
    assert.equal(after.hasToken, true);
    assert.equal(after.tokenPreview, before.tokenPreview);
    assert.equal(after.issuedAt, before.issuedAt);
  });

  test('概览：版本、计数、算子、磁盘、最近失败', async () => {
    const overview = await admin.get('/api/admin/overview');
    assert.match(overview.version, /^\d+\.\d+\.\d+/);
    assert.ok(overview.counts.users >= 1);
    assert.equal(overview.operators[0].id, 'op_default');
    assert.ok(overview.disk.data.free > 0);
    assert.equal(overview.masterKeySource, 'file');
  });
});

describe('关闭注册 + 密钥错误', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness({ ADMIN_EMAILS: ADMIN, REGISTRATION: 'closed', COMFY_SECRET: 'wrong' });
  });
  after(async () => h?.stop());

  test('REGISTRATION=closed：普通邮箱注册返回 403，管理员邮箱仍可注册', async () => {
    const anonymous = await (await fetch(`${h.base}/api/auth/me`)).json();
    assert.equal(anonymous.site.registration, 'closed');
    const response = await new Client(h.base).raw('POST', '/api/auth/register', { email: 'x@test.local', password: 'password123', name: 'x' });
    assert.equal(response.status, 403);
    const admin = await h.user(ADMIN);
    assert.equal((await admin.get('/api/auth/me')).user.isAdmin, true);
  });

  test('密钥错误：令牌卡显示登录错误', async () => {
    const admin = new Client(h.base);
    await admin.post('/api/auth/login', { email: ADMIN, password: 'password123' });
    const status = await admin.post('/api/admin/operators/op_default/token/renew');
    assert.equal(status.hasToken, false);
    assert.equal(status.lastVerifyOk, false);
    assert.match(status.lastLoginError, /appid 或 secret 错误/);
  });
});
