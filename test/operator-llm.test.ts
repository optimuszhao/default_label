// 朋友接口新能力：算子自带语言模型（优先于模拟写作助手、关掉思考）、分镜扩写、真正取消对方任务、
// 图生图重绘强度（denoise）、随机种子的多张图合成一个任务提交、批量前先用 AI 写视频分镜
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { type Client, type Harness, IMAGE_PARAMS, startHarness, until } from './harness.ts';

let h: Harness;
let me: Client;

before(async () => {
  h = await startHarness({ LLM_MOCK: '1' });
  me = await h.user();
});
after(async () => h?.stop());

const requests = async () => (await h.operatorRequests()) as { path: string; params: Record<string, unknown> }[];

async function done(client: Client, id: string): Promise<any> {
  return until(async () => {
    const task = (await client.get<any[]>('/api/tasks?limit=100')).find((t) => t.id === id);
    return task && ['succeeded', 'failed', 'canceled'].includes(task.status) ? task : null;
  }, 30_000, `任务 ${id}`);
}

describe('朋友接口新能力', () => {
  test('LLM 没有语言模型接口时用模拟写作助手；对方开了 /api/llm 就改用它，并关掉思考', async () => {
    let health = await me.get('/api/health?force=1');
    assert.equal(health.llmMode, 'mock');
    const mock = await me.post('/api/assist/expand', { prompt: '雨夜街头', mode: 'image' });
    assert.ok(!String(mock.prompt).startsWith('【算子模型】'));

    await h.scenario({ llm: true });
    health = await until(async () => {
      const value = await me.get('/api/health?force=1');
      return value.llmMode === 'operator' ? value : null;
    }, 10_000, '切到算子语言模型');
    assert.equal(health.llm, true);
    const real = await me.post('/api/assist/polish', { prompt: '雨夜霓虹街头的少女', mode: 'image' });
    assert.match(String(real.prompt), /^【算子模型】/, '结果来自算子的模型');
    const chat = (await requests()).filter((r) => r.path === '/api/llm/v1/chat/completions').at(-1)!;
    const messages = chat.params.messages as { role: string; content: string }[];
    assert.match(messages.at(-1)!.content, /\/no_think$/, '默认关掉思考');
    assert.equal(chat.params.stream, false);
  });

  test('分镜扩写：有算子的分镜接口就用它', async () => {
    await h.scenario({ llm: true });
    const result = await me.post('/api/assist/storyboard', { scene: '橘猫在屋顶等主人', duration: 5 });
    assert.match(String(result.prompt), /^【算子分镜】橘猫在屋顶等主人/);
    const call = (await requests()).filter((r) => r.path === '/api/llm/expand-prompt').at(-1)!;
    assert.equal(call.params.duration, 5);
  });

  test('取消任务时同时取消对方队列里的任务', async () => {
    await h.scenario({ pendingMs: 60_000 });
    const task = await me.post('/api/tasks', { type: 't2i', prompt: '取消我', params: IMAGE_PARAMS, runNow: true });
    await until(async () => (await me.get<any[]>('/api/tasks')).find((t) => t.id === task.id && t.status === 'running'), 10_000, '提交到算子');
    await me.post(`/api/tasks/${task.id}/cancel`);
    await until(async () => (await requests()).some((r) => /^\/api\/tasks\/fake-\d+\/cancel$/.test(r.path)), 10_000, '算子收到取消');
    await h.scenario({ pendingMs: 300 });
  });

  test('多张图：随机种子合成一个任务（count），锁定种子拆成多个任务；图生图带重绘强度', async () => {
    const before = (await requests()).length;
    const random = await me.post('/api/tasks', { type: 't2i', prompt: '三只猫', params: { ...IMAGE_PARAMS, count: 3 }, runNow: true });
    const finished = await done(me, random.id);
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.outputAssetIds.length, 3, '一个任务出 3 张');
    const submits = (await requests()).slice(before).filter((r) => r.path === '/api/generate/text2img');
    assert.equal(submits.length, 1);
    assert.equal(submits[0].params.count, 3);
    const seeds3 = await Promise.all(finished.outputAssetIds.map(async (id: string) => (await me.get(`/api/assets/${id}`)).gen?.seed ?? null));
    assert.equal(typeof seeds3[0], 'number', '第 1 张记下种子');
    assert.deepEqual(seeds3.slice(1), [null, null], '合并出图的第 2 张起种子未知，不显示假的种子');

    const mark = (await requests()).length;
    const locked = await me.post('/api/tasks', { type: 't2i', prompt: '三只狗', params: { ...IMAGE_PARAMS, count: 2, seed: 42 }, runNow: true });
    assert.equal((await done(me, locked.id)).outputAssetIds.length, 2);
    const seeds = (await requests()).slice(mark).filter((r) => r.path === '/api/generate/text2img').map((r) => r.params.seed);
    assert.deepEqual(seeds, [42, 43], '锁定种子时第 n 张用 种子+n');

    const reference = finished.outputAssetIds[0];
    const edit = await me.post('/api/tasks', { type: 'i2i', prompt: '改成水彩', params: { ...IMAGE_PARAMS, strength: 0.35 }, inputs: { referenceAssetIds: [reference] }, runNow: true });
    assert.equal((await done(me, edit.id)).status, 'succeeded');
    const img2img = (await requests()).filter((r) => r.path === '/api/generate/img2img').at(-1)!;
    assert.equal(img2img.params.denoise, 0.35);
  });

  test('批量出视频前先用 AI 写分镜：写进镜头，视频任务用分镜当提示词', async () => {
    await h.scenario({ llm: true });
    const story = await me.post('/api/stories', { title: '分镜', logline: '' });
    const t = Math.random().toString(36).slice(2, 7);
    await me.post(`/api/stories/${story.id}/ops`, {
      ops: [
        { op: 'create', entity: 'chapter', id: `ch_${t}`, sortKey: 'i', value: { title: '一' } },
        { op: 'create', entity: 'scene', id: `sc_${t}`, parentId: `ch_${t}`, sortKey: 'i', value: { title: '屋顶' } },
        { op: 'create', entity: 'shot', id: `s_${t}`, parentId: `sc_${t}`, sortKey: 'i', value: { shotSize: '远景', cameraMove: '推', description: '橘猫坐在屋顶看夕阳', duration: 5 } },
      ],
    });
    const request = { scope: { type: 'all' }, content: 'video', mode: 'missing', storyboard: true };
    const dry = await me.post(`/api/stories/${story.id}/generate`, { ...request, dryRun: true });
    assert.equal(dry.storyboardShots, 1);
    const started = await me.post(`/api/stories/${story.id}/generate`, request);
    assert.ok(started.job, '先排一个写分镜的作业');
    const task = await until(async () => (await me.get<any[]>(`/api/tasks?storyId=${story.id}`)).find((x) => x.link.purpose === 'video'), 20_000, '写完分镜后建视频任务');
    const after = await me.get(`/api/stories/${story.id}`);
    const shot = after.data.chapters[0].scenes[0].shots[0];
    assert.match(shot.storyboard, /^【算子分镜】/);
    assert.equal(task.prompt, shot.storyboard, '视频任务直接用分镜提示词');
  });
});
