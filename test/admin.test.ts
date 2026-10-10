// M0a · OPR-00（令牌状态 v0）、ACC-02 简版（ADMIN_EMAILS）、ACC-05（注册开关）
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client, startHarness, type Harness } from './harness.ts';

const ADMIN = 'boss@test.local';

describe('令牌状态（开放注册）', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness({ ADMIN_EMAILS: `Other@x.com, ${ADMIN.toUpperCase()}` });
  });
  after(async () => h?.stop());

  test('管理员能看到令牌状态，并能重新获取和校验', async () => {
    const admin = await h.user(ADMIN);
    const me = await admin.get('/api/auth/me');
    assert.equal(me.user.isAdmin, true);
    assert.equal(me.site.registration, 'open');

    const initial = await admin.get('/api/admin/token');
    assert.equal(initial.supported, true);
    assert.equal(initial.configured, true);
    assert.equal(initial.appid, 'dev');

    const renewed = await admin.post('/api/admin/token/renew');
    assert.equal(renewed.hasToken, true);
    assert.equal(renewed.lastVerifyOk, true);
    assert.equal(renewed.expiresBasis, 'assumed');
    const hours = (renewed.expiresAt - renewed.issuedAt) / 3600_000;
    assert.equal(Math.round(hours), 72);
    assert.match(renewed.tokenPreview, /^fake\..…\w{4}$/u);
    assert.ok(!JSON.stringify(renewed).includes('"token"'), '不返回完整令牌');

    const verified = await admin.post('/api/admin/token/verify');
    assert.equal(verified.lastVerifyOk, true);
  });

  test('令牌失效时“立即校验”报告失败，“重新获取”恢复', async () => {
    const admin = new Client(h.base);
    await admin.post('/api/auth/login', { email: ADMIN, password: 'password123' });
    await fetch(`${h.operator}/__control`, { method: 'POST', body: JSON.stringify({ unauthorized: 2 }) });
    const failed = await admin.post('/api/admin/token/verify');
    assert.equal(failed.lastVerifyOk, false);
    const renewed = await admin.post('/api/admin/token/renew');
    assert.equal(renewed.lastVerifyOk, true);
  });

  test('普通用户和未登录访问管理接口一律 404', async () => {
    const normal = await h.user();
    assert.equal((await normal.get('/api/auth/me')).user.isAdmin, false);
    assert.equal((await normal.raw('GET', '/api/admin/token')).status, 404);
    assert.equal((await normal.raw('POST', '/api/admin/token/renew')).status, 404);
    assert.equal((await fetch(`${h.base}/api/admin/token`)).status, 404);
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
    const status = await admin.post('/api/admin/token/renew');
    assert.equal(status.hasToken, false);
    assert.equal(status.lastVerifyOk, false);
    assert.match(status.lastLoginError, /appid 或 secret 错误/);
  });
});
