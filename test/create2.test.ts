// 创作台 2.0 · 接口：预设与模板、配方编译、创作流水、收藏、我的提示词、AI 辅助、内容管理
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { compose, emptyRecipe } from '../shared/compose.ts';
import { SEED_PRESETS, SEED_TEMPLATES } from '../shared/seed.ts';
import { IMAGE_PARAMS, VIDEO_PARAMS, Client, startHarness, until, type Harness } from './harness.ts';

const ADMIN = 'boss@test.local';

describe('目录与配方（comfyweb）', () => {
  let h: Harness;
  let user: Client;
  before(async () => {
    h = await startHarness({ ADMIN_EMAILS: ADMIN });
    user = await h.user();
  });
  after(async () => h?.stop());

  test('预设带 ETag，没变时 304', async () => {
    const first = await user.raw('GET', '/api/presets');
    const presets = await first.json();
    assert.equal(presets.length, SEED_PRESETS.length);
    const etag = first.headers.get('etag')!;
    const again = await user.raw('GET', '/api/presets', undefined, { 'if-none-match': etag });
    assert.equal(again.status, 304);
  });

  test('模板列表带热门分和收藏，精选在前', async () => {
    const templates = await user.get<any[]>('/api/templates');
    assert.equal(templates.length, SEED_TEMPLATES.length);
    const poster = templates.find((t) => t.id === 'movie-poster');
    assert.equal(poster.featured, true);
    assert.ok(poster.hot >= 3);
    await user.json('PUT', '/api/favorites', { kind: 'template', ref: 'food', on: true });
    assert.equal((await user.get<any[]>('/api/templates')).find((t) => t.id === 'food').favorite, true);
    await user.json('PUT', '/api/favorites', { kind: 'template', ref: 'food', on: false });
    assert.equal((await user.get<any[]>('/api/templates')).find((t) => t.id === 'food').favorite, false);
  });

  test('配方由服务端编译：和前端编译结果一致，记录配方', async () => {
    const caps = await user.get('/api/capabilities');
    const presets = await user.get<any[]>('/api/presets');
    const catalog = new Map(presets.map((p) => [p.slug, p]));
    const template = (await user.get<any[]>('/api/templates')).find((t) => t.id === 'movie-poster');
    const recipe = { ...emptyRecipe('image'), templateId: 'movie-poster', vars: { 主体: '机甲少女' }, text: '背景有烟花', presets: ['style-ink', 'neg-quality'], overrides: { seed: 7 } };
    const local = compose({ recipe, template, catalog, caps });
    const task = await user.post('/api/tasks', { type: 't2i', params: IMAGE_PARAMS, recipe });
    assert.equal(task.prompt, local.prompt, '前后端编译结果一致');
    assert.equal(task.negativePrompt, local.negativePrompt);
    assert.equal(task.params.aspectRatio, '3:4');
    assert.equal(task.params.seed, 7);
    assert.match(task.prompt, /水墨/, '先选模板的电影感，再选水墨 → 水墨');
    assert.doesNotMatch(task.prompt, /电影感画面/);
    assert.equal(task.recipe.templateId, 'movie-poster');
    assert.deepEqual(task.recipe.vars, { 主体: '机甲少女' });

    const done = await until(async () => {
      const t = (await user.get<any[]>('/api/tasks')).find((x) => x.id === task.id);
      return t?.status === 'succeeded' ? t : null;
    }, 15_000, '出图');
    // 删除任务后资产上的配方信息依然完整
    await user.json('DELETE', `/api/tasks/${done.id}`);
    const asset = (await user.get<any[]>('/api/assets')).find((a) => a.id === done.outputAssetIds[0]);
    assert.equal(asset.gen.seed, 7);
    assert.equal(asset.gen.templateId, 'movie-poster');
    assert.ok(asset.gen.presets.includes('style-ink'));
  });

  test('再来一次：保留配方，种子换新', async () => {
    const recipe = { ...emptyRecipe('image'), text: '海边的灯塔', presets: ['light-golden'], overrides: { seed: 99 } };
    const task = await user.post('/api/tasks', { type: 't2i', params: IMAGE_PARAMS, recipe });
    await until(async () => (await user.get<any[]>('/api/tasks')).find((x) => x.id === task.id)?.status === 'succeeded', 15_000, '完成');
    const copy = await user.post(`/api/tasks/${task.id}/retry`);
    assert.equal(copy.recipe.text, '海边的灯塔');
    assert.deepEqual(copy.recipe.presets, ['light-golden']);
    assert.equal(copy.recipe.overrides.seed, null);
    assert.equal(copy.params.seed, null);
  });

  test('视频配方：comfyweb 不支持反向词 → fallback 变成正向约束；时长收进范围', async () => {
    const recipe = { ...emptyRecipe('video'), text: '海浪拍打礁石', presets: ['neg-flicker', 'camera-push'], overrides: { duration: 20, aspectRatio: '16:9' } };
    const task = await user.post('/api/tasks', { type: 't2v', params: VIDEO_PARAMS, recipe });
    assert.equal(task.negativePrompt, '');
    assert.match(task.prompt, /画面稳定连贯/);
    assert.match(task.prompt, /镜头缓慢向前推进/);
    assert.equal(task.params.duration, 15);
    assert.equal(task.params.width, 1344);
  });

  test('派生：parentAssetId 写到产物上；不能引用别人的资产', async () => {
    const parent = await user.post('/api/tasks', { type: 't2i', params: IMAGE_PARAMS, recipe: { ...emptyRecipe('image'), text: '原图' } });
    const parentDone = await until(async () => {
      const t = (await user.get<any[]>('/api/tasks')).find((x) => x.id === parent.id);
      return t?.status === 'succeeded' ? t : null;
    }, 15_000, '原图完成');
    const parentAssetId = parentDone.outputAssetIds[0];
    const child = await user.post('/api/tasks', {
      type: 'i2i',
      params: IMAGE_PARAMS,
      inputs: { referenceAssetIds: [parentAssetId] },
      recipe: { ...emptyRecipe('image'), text: '变体', parentAssetId },
    });
    const childDone = await until(async () => {
      const t = (await user.get<any[]>('/api/tasks')).find((x) => x.id === child.id);
      return t?.status === 'succeeded' ? t : null;
    }, 15_000, '变体完成');
    const asset = (await user.get<any[]>('/api/assets')).find((a) => a.id === childDone.outputAssetIds[0]);
    assert.equal(asset.parentAssetId, parentAssetId);

    const other = await h.user();
    const stolen = await other.raw('POST', '/api/tasks', { type: 't2i', params: IMAGE_PARAMS, recipe: { ...emptyRecipe('image'), text: 'x', parentAssetId } });
    assert.equal(stolen.status, 400);
  });

  test('配方错误：模板不存在、模式不一致、空提示词', async () => {
    const missing = await user.raw('POST', '/api/tasks', { type: 't2i', params: IMAGE_PARAMS, recipe: { ...emptyRecipe('image'), templateId: 'nope' } });
    assert.equal(missing.status, 400);
    const mismatch = await user.raw('POST', '/api/tasks', { type: 't2v', params: VIDEO_PARAMS, recipe: { ...emptyRecipe('image'), text: '猫' } });
    assert.equal(mismatch.status, 400);
    const empty = await user.raw('POST', '/api/tasks', { type: 't2i', params: IMAGE_PARAMS, recipe: emptyRecipe('image') });
    assert.equal(empty.status, 400);
  });

  test('同一个人一天用同一个模板 10 次，热门分只计 1 次', async () => {
    const counter = await h.user();
    for (let i = 0; i < 10; i++) {
      await counter.post('/api/tasks', { type: 't2i', params: IMAGE_PARAMS, recipe: { ...emptyRecipe('image'), templateId: 'avatar' } });
    }
    const avatar = (await counter.get<any[]>('/api/templates')).find((t) => t.id === 'avatar');
    assert.equal(avatar.uses, 1);
  });

  test('我的提示词：增删查', async () => {
    const saved = await user.post('/api/prompts', { name: '我的猫', body: '{颜色}的猫', mode: 'image' });
    assert.ok((await user.get<any[]>('/api/prompts')).some((p) => p.id === saved.id));
    await user.json('DELETE', `/api/prompts/${saved.id}`);
    assert.ok(!(await user.get<any[]>('/api/prompts')).some((p) => p.id === saved.id));
  });

  test('最近使用的配方去重', async () => {
    const recent = await user.get<any[]>('/api/recipes/recent');
    assert.ok(recent.length >= 2);
    const keys = recent.map((r) => JSON.stringify([r.recipe.mode, r.recipe.text, r.recipe.templateId, r.recipe.vars, r.recipe.presets]));
    assert.equal(new Set(keys).size, keys.length);
  });

  test('没有语言模型：随机灵感改用离线词库，扩写返回 503', async () => {
    const ideas = await user.post('/api/assist/inspire', { mode: 'image' });
    assert.equal(ideas.ideas.length, 4);
    assert.equal(ideas.offline, true);
    const expand = await user.raw('POST', '/api/assist/expand', { prompt: '猫', mode: 'image' });
    assert.equal(expand.status, 503);
  });

  test('管理员改模板后用户立即看到；预设停用后不再生效', async () => {
    const admin = await h.user(ADMIN);
    await admin.patch('/api/admin/templates/food', { name: '深夜食堂', featured: true });
    assert.equal((await user.get<any[]>('/api/templates')).find((t) => t.id === 'food').name, '深夜食堂');
    await admin.patch('/api/admin/presets/style-ink', { enabled: false });
    assert.ok(!(await user.get<any[]>('/api/presets')).some((p) => p.slug === 'style-ink'));
    const task = await user.post('/api/tasks', { type: 't2i', params: IMAGE_PARAMS, recipe: { ...emptyRecipe('image'), text: '山', presets: ['style-ink'] } });
    assert.equal(task.prompt, '山');
    const created = await admin.post('/api/admin/templates', { id: 'my-test', name: '我的模板', mode: 'image', body: '{主体}在月光下', variables: [{ key: '主体', label: '主体', default: '狐狸' }] });
    assert.equal(created.id, 'my-test');
    const used = await user.post('/api/tasks', { type: 't2i', params: IMAGE_PARAMS, recipe: { ...emptyRecipe('image'), templateId: 'my-test' } });
    assert.equal(used.prompt, '狐狸在月光下');
    const normal = await user.raw('PATCH', '/api/admin/templates/food', { name: 'x' });
    assert.equal(normal.status, 404);
  });
});

describe('创作流水与 AI 辅助（模拟算子）', () => {
  let h: Harness;
  let user: Client;
  before(async () => {
    h = await startHarness({ PROVIDER: 'mock' });
    user = await h.user();
  });
  after(async () => h?.stop());

  test('灌入 1000 条任务：流水能翻到最早一条；检索命中 2 个字和 4 个字', async () => {
    const me = (await user.get('/api/auth/me')).user.id;
    const db = new DatabaseSync(path.join(h.dataDir, 'weave.db'));
    const insert = db.prepare(
      `INSERT INTO tasks (id, user_id, type, status, title, prompt, negative_prompt, params, inputs, max_attempts, created_at, updated_at, output_asset_ids)
       VALUES (?, ?, ?, 'succeeded', ?, ?, '', '{}', '{}', 3, ?, ?, '[]')`,
    );
    db.exec('BEGIN');
    for (let i = 0; i < 1000; i++) {
      const prompt = i === 0 ? '赛博朋克的拉面摊' : i === 500 ? '一碗拉面' : `第 ${i} 张图`;
      insert.run(`t_bulk_${String(i).padStart(4, '0')}`, me, i % 3 === 0 ? 't2v' : 't2i', prompt, prompt, 1_700_000_000_000 + i * 1000, 1_700_000_000_000 + i * 1000);
    }
    db.exec('COMMIT');
    db.close();

    let cursor: string | null = null;
    let total = 0;
    let oldest = '';
    for (let page = 0; page < 50; page++) {
      const result: { tasks: { id: string }[]; next: string | null } = await user.get(`/api/feed?limit=100${cursor ? `&before=${cursor}` : ''}`);
      total += result.tasks.length;
      oldest = result.tasks.at(-1)?.id ?? oldest;
      cursor = result.next;
      if (!cursor) break;
    }
    assert.equal(total, 1000);
    assert.equal(oldest, 't_bulk_0000');

    const started = performance.now();
    const ramen = await user.get('/api/feed?q=拉面');
    const elapsed = performance.now() - started;
    assert.equal(ramen.tasks.length, 2);
    assert.equal((await user.get('/api/feed?q=赛博朋克')).tasks.length, 1);
    assert.ok(elapsed < 100, `检索耗时 ${elapsed.toFixed(1)} ms`);
    const videos = await user.get('/api/feed?kind=video&limit=100');
    assert.ok(videos.tasks.every((t: { type: string }) => t.type === 't2v'));
  });

  test('AI 辅助：扩写、翻译保留变量、变体、填变量、动作建议、灵感', async () => {
    assert.ok((await user.post('/api/assist/expand', { prompt: '猫', mode: 'image' })).prompt.length > 20);
    assert.match((await user.post('/api/assist/translate', { prompt: '{主体}在雨中', to: 'en' })).prompt, /\{主体\}/);
    assert.equal((await user.post('/api/assist/variants', { prompt: '灯塔' })).variants.length, 4);
    const filled = await user.post('/api/assist/fill', { idea: '雪地里的狼', body: '{主体}在{场景}', variables: [{ key: '主体' }, { key: '场景', default: '森林' }] });
    assert.deepEqual(Object.keys(filled.vars), ['主体', '场景']);
    assert.equal((await user.post('/api/assist/motion', { prompt: '少女站在花田' })).motions.length, 3);
    assert.equal((await user.post('/api/assist/inspire', { mode: 'video' })).ideas.length, 4);
  });

  test('第 31 次 AI 请求返回 429', async () => {
    const busy = await h.user();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await busy.raw('POST', '/api/assist/variants', { prompt: `测试 ${i}` })).status;
    assert.equal(last, 429);
  });
});
