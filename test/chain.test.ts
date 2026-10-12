// STY-09 接续上一镜尾帧：批量里上一镜的视频也要出时排在它后面、截它的尾帧做首帧，一镜接一镜；
// "先关键帧再视频"里接续的镜头不出关键帧；单镜排队等上一镜、取消等待
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { type Client, type Harness, startHarness, until } from './harness.ts';

const FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

let h: Harness;
let me: Client;

before(async () => {
  h = await startHarness();
  me = await h.user();
  await h.scenario({ realMedia: true });
});
after(async () => h?.stop());

/** 一场三镜：第 2、3 镜设成"接续上一镜尾帧"（relay 指定哪些镜头接续） */
async function makeStory(relay: number[] = [2, 3]) {
  const story = await me.post('/api/stories', { title: '接续测试', logline: '' });
  const t = Math.random().toString(36).slice(2, 7);
  const shots = [1, 2, 3].map((n) => `s${n}_${t}`);
  await me.post(`/api/stories/${story.id}/ops`, {
    ops: [
      { op: 'create', entity: 'chapter', id: `ch_${t}`, sortKey: 'i', value: { title: '第一章' } },
      { op: 'create', entity: 'scene', id: `sc_${t}`, parentId: `ch_${t}`, sortKey: 'i', value: { title: '花园' } },
      ...shots.map((id, i) => ({
        op: 'create', entity: 'shot', id, parentId: `sc_${t}`, sortKey: 'abc'[i],
        value: { shotSize: '中景', cameraMove: '固定', description: `第 ${i + 1} 段动作`, dialogueIds: [], duration: 2, characterIds: [], keyframeAssetId: null, videoAssetId: null, ...(relay.includes(i + 1) ? { firstFrame: { mode: 'prev_last' } } : {}) },
      })),
    ],
  });
  return { id: story.id as string, shots };
}

async function videoTaskOf(storyId: string, shotId: string, timeout = 60_000): Promise<any> {
  return until(async () => (await me.get<any[]>(`/api/tasks?storyId=${storyId}&limit=100`)).find((t) => t.link.shotId === shotId && t.link.purpose === 'video' && t.status === 'succeeded'), timeout, `镜头 ${shotId} 的视频`);
}

describe('STY-09 接续上一镜尾帧', { skip: !FFMPEG && '没有 ffmpeg' }, () => {
  test('批量出视频：第 2 镜等第 1 镜、第 3 镜等第 2 镜，各自用上一镜的尾帧做首帧', async () => {
    const story = await makeStory();
    const request = { scope: { type: 'all' }, content: 'video', mode: 'missing' };
    const { plan } = await me.post(`/api/stories/${story.id}/generate`, { ...request, dryRun: true });
    assert.equal(plan.items.length, 1, '只有第 1 镜马上开始');
    assert.deepEqual(plan.chained.map((c: any) => c.shotId), story.shots.slice(1));
    assert.equal(plan.chainLongest, 3);
    assert.equal(plan.tasks, 3);

    await me.post(`/api/stories/${story.id}/generate`, request);
    const waiting = await me.get<any[]>(`/api/stories/${story.id}/chains`);
    assert.equal(waiting.length, 2);

    const v1 = await videoTaskOf(story.id, story.shots[0]);
    const v2 = await videoTaskOf(story.id, story.shots[1]);
    const v3 = await videoTaskOf(story.id, story.shots[2]);
    const frame2 = await me.get(`/api/assets/${v2.inputs.firstFrameAssetId}`);
    assert.equal(frame2.lineage, 'frame');
    assert.equal(frame2.parentAssetId, v1.outputAssetIds[0], '第 2 镜首帧截自第 1 镜视频');
    const frame3 = await me.get(`/api/assets/${v3.inputs.firstFrameAssetId}`);
    assert.equal(frame3.parentAssetId, v2.outputAssetIds[0], '第 3 镜首帧截自第 2 镜视频');
    assert.equal(v2.type, 'i2v');
    assert.equal((await me.get<any[]>(`/api/stories/${story.id}/chains`)).length, 0, '等待全部完成');
  });

  test('先关键帧再视频：接续的镜头不出关键帧，第 1 镜关键帧 → 视频 → 第 2 镜接续', async () => {
    const story = await makeStory([2]);
    const request = { scope: { type: 'shots', ids: story.shots.slice(0, 2) }, content: 'keyframe_then_video', mode: 'missing' };
    const { plan } = await me.post(`/api/stories/${story.id}/generate`, { ...request, dryRun: true });
    assert.deepEqual(plan.items.map((i: any) => `${i.purpose}`), ['keyframe']);
    assert.equal(plan.followUps, 1);
    assert.equal(plan.chained.length, 1);
    await me.post(`/api/stories/${story.id}/generate`, request);
    const v2 = await videoTaskOf(story.id, story.shots[1]);
    const v1 = await videoTaskOf(story.id, story.shots[0]);
    assert.equal((await me.get(`/api/assets/${v2.inputs.firstFrameAssetId}`)).parentAssetId, v1.outputAssetIds[0]);
    const tasks = await me.get<any[]>(`/api/tasks?storyId=${story.id}&limit=100`);
    assert.ok(!tasks.some((t) => t.link.shotId === story.shots[1] && t.link.purpose === 'keyframe'), '第 2 镜没有出关键帧');
  });

  test('单镜排在上一镜后面；可以取消等待；第一个镜头不能接续', async () => {
    const story = await makeStory([2, 3]);
    assert.equal((await me.raw('POST', `/api/stories/${story.id}/chains`, { shotId: story.shots[0] })).status, 400);
    await me.post(`/api/stories/${story.id}/chains`, { shotId: story.shots[1] });
    await me.post(`/api/stories/${story.id}/chains`, { shotId: story.shots[2] });
    await me.json('DELETE', `/api/stories/${story.id}/chains/${story.shots[2]}`);
    assert.deepEqual((await me.get<any[]>(`/api/stories/${story.id}/chains`)).map((c) => c.shotId), [story.shots[1]]);
    // 只给第 1 镜出视频：完成后第 2 镜自动接上，第 3 镜（已取消）不动
    await me.post(`/api/stories/${story.id}/generate`, { scope: { type: 'shots', ids: [story.shots[0]] }, content: 'video', mode: 'missing' });
    const v1 = await videoTaskOf(story.id, story.shots[0]);
    const v2 = await videoTaskOf(story.id, story.shots[1]);
    assert.equal((await me.get(`/api/assets/${v2.inputs.firstFrameAssetId}`)).parentAssetId, v1.outputAssetIds[0]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const tasks = await me.get<any[]>(`/api/tasks?storyId=${story.id}&limit=100`);
    assert.ok(!tasks.some((t) => t.link.shotId === story.shots[2]), '取消等待的第 3 镜没有任务');
  });
});
