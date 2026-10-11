// M7b 故事生产：提示词构建器、设定库、批量生成（试算、跳过规则、先关键帧再视频、闲时）、定稿保护、系列、长篇 AI、加入故事镜头
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { buildShotPrompt, findMentions, PROMPT_LIMIT } from '../shared/story-prompt.ts';
import { diffStory, type SortKeys } from '../shared/story-ops.ts';
import type { Scene, Shot, StoryData } from '../shared/types.ts';
import { type Client, type Harness, IMAGE_PARAMS, startHarness, until } from './harness.ts';

let h: Harness;
let user: Client;

const hour = new Date().getHours();
// 闲时时段设在两小时之后，保证"现在"不在闲时内
const idleStart = `${String((hour + 2) % 24).padStart(2, '0')}:00`;
const idleEnd = `${String((hour + 3) % 24).padStart(2, '0')}:00`;

before(async () => {
  h = await startHarness({ LLM_MOCK: '1', IDLE_WINDOW: `${idleStart}-${idleEnd}` });
  user = await h.user();
});
after(async () => h?.stop());

function sample(t = ''): StoryData {
  const data: StoryData = {
    logline: '',
    genre: '',
    tone: '',
    visualStyle: '赛博朋克，霓虹光影',
    aspectRatio: '16:9',
    outline: '',
    characters: [
      { id: 'c_lin', name: '林昔', role: '主角', appearance: '短发少女，红色雨衣', personality: '', referenceAssetId: null, aliases: ['小昔'], seed: 777, outfits: [{ id: 'o1', name: '校服', snippet: '蓝白校服' }], negative: '浓妆' },
    ],
    elements: [
      { id: 'e_city', kind: 'location', name: '旧城区', snippet: '残破高楼，积水倒映霓虹' },
      { id: 'e_radio', kind: 'prop', name: '收音机', snippet: '掉漆木壳，橙色指示灯' },
    ],
    chapters: [
      {
        id: 'ch_p1',
        title: '一',
        summary: '',
        scenes: [
          {
            id: 'sc_p1',
            title: '雨夜',
            location: '街头',
            locationId: 'e_city',
            time: '夜',
            summary: '',
            dialogue: [{ id: 'd_p1', characterId: 'c_lin', text: '有人吗？', emotion: '紧张' }],
            shots: [
              { id: 'sh_p1', shotSize: '远景', cameraMove: '推', description: '@小昔 撑伞走过街头', dialogueIds: ['d_p1'], duration: 5, characterIds: ['c_lin'], elementIds: ['e_radio'], keyframeAssetId: null, videoAssetId: null },
              { id: 'sh_p2', shotSize: '近景', cameraMove: '固定', description: '收音机特写', dialogueIds: [], duration: 4, characterIds: [], keyframeAssetId: null, videoAssetId: null },
              { id: 'sh_p3', shotSize: '中景', cameraMove: '固定', description: '', dialogueIds: [], duration: 4, characterIds: [], keyframeAssetId: null, videoAssetId: null },
            ],
          },
        ],
      },
    ],
  };
  // 每个故事用自己的一套 id（id 全局唯一）
  return t ? (JSON.parse(JSON.stringify(data).replace(/"((?:c|e|ch|sc|sh|d|o)_[a-z]+\d?)"/g, `"$1${t}"`)) as StoryData) : data;
}

async function newStory(client: Client, data: StoryData, title = '生产'): Promise<string> {
  const created = await client.post('/api/stories', { title, logline: '' });
  const keys: SortKeys = new Map(Object.entries(created.keys ?? {}));
  const ops = diffStory({ title: created.title, data: created.data }, { title, data }, keys);
  await client.post(`/api/stories/${created.id}/ops`, { ops });
  return created.id;
}

async function edit(client: Client, id: string, change: (data: StoryData) => void): Promise<void> {
  const story = await client.get(`/api/stories/${id}`);
  const keys: SortKeys = new Map(Object.entries(story.keys ?? {}));
  const next = structuredClone(story.data as StoryData);
  change(next);
  await client.post(`/api/stories/${id}/ops`, { ops: diffStory({ title: story.title, data: story.data }, { title: story.title, data: next }, keys) });
}

async function storyTasks(client: Client, id: string): Promise<any[]> {
  return client.get<any[]>(`/api/tasks?storyId=${id}&limit=1000`);
}

describe('M7b 故事生产', () => {
  test('STY-03 提示词构建器：按段拼装，角色带外貌和服装，@ 提及去掉符号；超长时先去台词和道具，画面描述保留', () => {
    const data = sample();
    const scene = data.chapters[0].scenes[0];
    const shot = scene.shots[0];
    const keyframe = buildShotPrompt(data, scene, shot, { purpose: 'keyframe', outfits: { c_lin: 'o1' } });
    assert.deepEqual(keyframe.segments.map((s) => s.kind), ['style', 'location', 'camera', 'description', 'character', 'prop']);
    assert.match(keyframe.prompt, /残破高楼/);
    assert.match(keyframe.prompt, /林昔（短发少女，红色雨衣，蓝白校服）/);
    assert.ok(!keyframe.prompt.includes('@'));
    assert.match(keyframe.negative, /浓妆/);
    assert.equal(keyframe.seed, 777, '镜头没锁种子时用角色的固定种子');
    const video = buildShotPrompt(data, scene, shot, { purpose: 'video' });
    assert.ok(video.segments.some((s) => s.kind === 'dialogue'));
    assert.match(video.prompt, /推镜头/);
    const long: Shot = { ...shot, description: '雨'.repeat(420), extraPrompt: '光'.repeat(200) };
    const cut = buildShotPrompt(data, scene, long, { purpose: 'video' });
    assert.ok(cut.prompt.length <= PROMPT_LIMIT + 5, `长度 ${cut.prompt.length}`);
    assert.ok(cut.dropped.includes('dialogue') && cut.dropped.includes('prop'));
    assert.ok(cut.segments.some((s) => s.kind === 'description'));
    const override = buildShotPrompt(data, scene, { ...shot, promptOverride: '完全手写的提示词', seed: 5 } as Shot, { purpose: 'keyframe' });
    assert.equal(override.prompt, '完全手写的提示词');
    assert.equal(override.seed, 5);
  });

  test('STY-07 @ 提及自动识别角色（含别名）和设定', () => {
    const mentions = findMentions('@小昔 打开 @收音机，走进 @旧城区', sample());
    assert.deepEqual(mentions.characterIds, ['c_lin']);
    assert.deepEqual(mentions.elementIds.sort(), ['e_city', 'e_radio']);
  });

  test('STY-07 设定库：角色 v2 字段、地点道具设定、镜头出镜设定都能保存和读回', async () => {
    const id = await newStory(user, sample('a'));
    const story = await user.get(`/api/stories/${id}`);
    const lin = story.data.characters[0];
    assert.deepEqual(lin.aliases, ['小昔']);
    assert.equal(lin.seed, 777);
    assert.equal(lin.outfits[0].snippet, '蓝白校服');
    assert.equal(lin.negative, '浓妆');
    assert.deepEqual(story.data.elements.map((e: any) => e.id).sort(), ['e_citya', 'e_radioa']);
    assert.equal(story.data.chapters[0].scenes[0].locationId, 'e_citya');
    const shot = story.data.chapters[0].scenes[0].shots[0];
    assert.deepEqual(shot.characterIds, ['c_lina']);
    assert.deepEqual(shot.elementIds, ['e_radioa']);
    // 只改出镜角色时道具保留
    await edit(user, id, (d) => (d.chapters[0].scenes[0].shots[0].characterIds = []));
    const after = (await user.get(`/api/stories/${id}`)).data.chapters[0].scenes[0].shots[0];
    assert.deepEqual(after.characterIds, []);
    assert.deepEqual(after.elementIds, ['e_radioa']);
  });

  test('STY-09 批量试算：任务数、跳过（定稿、无描述）、GPU 时长；先关键帧再视频的视频算在后续', async () => {
    const id = await newStory(user, sample('b'));
    await edit(user, id, (d) => (d.chapters[0].scenes[0].shots[1].locked = true));
    const { plan } = await user.post(`/api/stories/${id}/generate`, { scope: { type: 'all' }, content: 'keyframe_then_video', mode: 'missing', dryRun: true });
    assert.equal(plan.items.length, 1, '只有第 1 镜：第 2 镜定稿，第 3 镜没有描述');
    assert.equal(plan.followUps, 1);
    assert.equal(plan.tasks, 2);
    assert.equal(plan.skipped.locked, 1);
    assert.equal(plan.skipped.noDescription, 1);
    assert.ok(plan.gpuSeconds > 30);
    assert.ok(plan.etaSeconds >= plan.gpuSeconds / 4);
    assert.equal((await storyTasks(user, id)).length, 0, '试算不创建任务');
  });

  test('STY-09 先关键帧再视频：提交前自动快照；关键帧完成后自动接着建视频任务，首帧用新关键帧', async () => {
    const id = await newStory(user, sample('c'));
    const { created } = await user.post(`/api/stories/${id}/generate`, { scope: { type: 'scene', id: 'sc_p1c' }, content: 'keyframe_then_video', mode: 'missing' });
    assert.equal(created, 2, '第 1、2 镜的关键帧');
    const snapshots = await user.get<any[]>(`/api/stories/${id}/snapshots`);
    assert.ok(snapshots.some((s) => s.reason === 'before_batch'));
    const video = await until(async () => (await storyTasks(user, id)).find((t) => t.link.purpose === 'video' && t.link.shotId === 'sh_p1c'), 30_000, '视频任务');
    assert.equal(video.type, 'i2v');
    const keyframeTask = (await storyTasks(user, id)).find((t) => t.link.purpose === 'keyframe' && t.link.shotId === 'sh_p1c');
    assert.equal(video.inputs.firstFrameAssetId, keyframeTask.outputAssetIds[0]);
    assert.equal(video.params.seed, 777);
    // 再跑一次"只补缺"：已经有关键帧的跳过
    const again = await user.post(`/api/stories/${id}/generate`, { scope: { type: 'all' }, content: 'keyframe', mode: 'missing', dryRun: true });
    assert.ok(again.plan.skipped.hasResult + again.plan.skipped.active >= 2);
  });

  test('STY-08 定稿的镜头不会被批量操作改动；新候选不改变已固定的选定', async () => {
    const id = await newStory(user, sample('d'));
    await user.post(`/api/stories/${id}/generate`, { scope: { type: 'shots', ids: ['sh_p1d'] }, content: 'keyframe', mode: 'missing' });
    const first = await until(async () => (await storyTasks(user, id)).find((t) => t.status === 'succeeded'), 30_000, '关键帧');
    const pinned = first.outputAssetIds[0];
    await edit(user, id, (d) => {
      d.chapters[0].scenes[0].shots[0].keyframeAssetId = pinned;
    });
    // 追加模式：没定稿时会出新候选，但显式选定不变
    await user.post(`/api/stories/${id}/generate`, { scope: { type: 'shots', ids: ['sh_p1d'] }, content: 'keyframe', mode: 'append' });
    await until(async () => (await storyTasks(user, id)).filter((t) => t.status === 'succeeded').length === 2, 30_000, '第二个候选');
    assert.equal((await user.get(`/api/stories/${id}`)).data.chapters[0].scenes[0].shots[0].keyframeAssetId, pinned);
    // 定稿后：重做模式也不动它
    await edit(user, id, (d) => (d.chapters[0].scenes[0].shots[0].locked = true));
    const redo = await user.post(`/api/stories/${id}/generate`, { scope: { type: 'shots', ids: ['sh_p1d'] }, content: 'keyframe', mode: 'redo' });
    assert.equal(redo.created, 0);
    assert.equal(redo.plan.skipped.locked, 1);
  });

  test('STY-09 闲时通道：任务排队但到闲时时段才开始派发', async () => {
    const id = await newStory(user, sample('e'));
    const result = await user.post(`/api/stories/${id}/generate`, { scope: { type: 'shots', ids: ['sh_p2e'] }, content: 'keyframe', mode: 'missing', idle: true });
    assert.equal(result.created, 1);
    assert.ok(result.plan.startsAt > Date.now());
    const db = new DatabaseSync(path.join(h.dataDir, 'weave.db'));
    const row = db.prepare("SELECT status, next_attempt_at FROM tasks WHERE story_id = ? AND shot_id = 'sh_p2e'").get(id) as { status: string; next_attempt_at: number };
    db.close();
    assert.equal(row.status, 'queued');
    assert.equal(row.next_attempt_at, result.plan.startsAt);
  });

  test('STY-17 系列：新一集继承系列设定、复制上一集结构；共享设定在各集之间同步；系列看板有每集进度', async () => {
    const series = await user.post('/api/series', { title: '回声之城', settings: { visualStyle: '水彩绘本', aspectRatio: '9:16' } });
    const ep1 = await user.post(`/api/series/${series.id}/episodes`, { title: '第一集' });
    assert.equal(ep1.data.visualStyle, '水彩绘本');
    assert.equal(ep1.episodeNo, 1);
    await edit(user, ep1.id, (d) => {
      d.characters.push({ id: 'c_shared', name: '林昔', role: '主角', appearance: '短发', personality: '', referenceAssetId: null, seriesShared: true });
      d.characters.push({ id: 'c_local', name: '路人', role: '配角', appearance: '', personality: '', referenceAssetId: null });
      d.chapters.push({ id: 'ch_e1', title: '开端', summary: '', recap: '林昔离开家乡', scenes: [{ id: 'sc_e1', title: '车站', location: '车站', time: '清晨', summary: '', dialogue: [], shots: [] }] });
    });
    const ep2 = await user.post(`/api/series/${series.id}/episodes`, { title: '第二集' });
    assert.equal(ep2.episodeNo, 2);
    assert.deepEqual(ep2.data.chapters.map((c: any) => c.title), ['开端'], '复制了上一集的章节结构');
    assert.equal(ep2.data.chapters[0].scenes[0].title, '车站');
    assert.notEqual(ep2.data.chapters[0].id, 'ch_e1', '结构复制用新的 id');
    assert.deepEqual(ep2.data.characters.map((c: any) => c.id), ['c_shared'], '只看到共享的角色');
    // 在第二集里改共享角色，第一集同步
    await edit(user, ep2.id, (d) => (d.characters[0].appearance = '短发，红色雨衣'));
    assert.equal((await user.get(`/api/stories/${ep1.id}`)).data.characters.find((c: any) => c.id === 'c_shared').appearance, '短发，红色雨衣');
    const board = await user.get(`/api/series/${series.id}`);
    assert.equal(board.episodes.length, 2);
    assert.equal(board.shared.length, 1);
    assert.equal(board.episodes[0].progress.shots, 0);
    const context = await user.get(`/api/stories/${ep2.id}/context`);
    assert.deepEqual(context.previous[0].recaps, ['开端：林昔离开家乡']);
  });

  test('STY-14 长篇 AI：章节前情提要、从剧本提取设定、原著长文拆章（模拟助手）', async () => {
    const recap = await user.post('/api/assist/recap', { chapterTitle: '第一章', scenes: [], previous: ['前情'] });
    assert.ok(recap.recap.length > 20);
    const extract = await user.post('/api/assist/extract', { script: '林昔：你好。\n阿铁：小心。' });
    assert.deepEqual(extract.characters.map((c: any) => c.name), ['林昔', '阿铁']);
    const split = await user.post('/api/assist/split', { source: '第一章 出发\n林昔离开家乡。\n\n第二章 相遇\n她遇见了阿铁。', chapterCount: 2 });
    assert.equal(split.chapters.length, 2);
  });

  test('CRT-10 从创作台把素材加入故事镜头', async () => {
    const id = await newStory(user, sample('f'));
    const task = await user.post('/api/tasks', { type: 't2i', prompt: '收音机静物', params: IMAGE_PARAMS });
    const done = await until(async () => (await user.get<any[]>('/api/tasks')).find((t) => t.id === task.id && t.status === 'succeeded'), 30_000, '生成');
    const assetId = done.outputAssetIds[0];
    const result = await user.post(`/api/stories/${id}/shots/from-asset`, { assetId, sceneId: 'sc_p1f' });
    const story = await user.get(`/api/stories/${id}`);
    const shots = story.data.chapters[0].scenes[0].shots as Shot[];
    assert.equal(shots.at(-1)!.id, result.shotId);
    assert.equal(shots.at(-1)!.keyframeAssetId, assetId);
    assert.equal(shots.at(-1)!.description, '收音机静物');
    const asset = await user.get(`/api/assets/${assetId}`);
    assert.equal(asset.shotId, result.shotId);
    void (null as unknown as Scene);
  });
});
