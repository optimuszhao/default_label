// M8b 成片与配音：模拟配音写回台词、成片渲染（裁剪点、静帧补位、混入配音、版本号）、故事包导出导入（id 重映射）、审片备注
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { Client, type Harness, IMAGE_PARAMS, startHarness, until, VIDEO_PARAMS } from './harness.ts';

const FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

let h: Harness;
let me: Client;

before(async () => {
  h = await startHarness();
  me = await h.user();
});
after(async () => h?.stop());

async function waitJob(client: Client, id: string, timeout = 60_000): Promise<any> {
  return until(async () => {
    const job = await client.get(`/api/jobs/${id}`);
    return ['succeeded', 'failed', 'canceled'].includes(job.status) ? job : null;
  }, timeout, `作业 ${id}`);
}

async function generate(client: Client, type: 't2i' | 't2v', prompt: string, params: Record<string, unknown>): Promise<string> {
  const task = await client.post('/api/tasks', { type, prompt, params, runNow: true });
  const done = await until(async () => (await client.get<any[]>('/api/tasks?limit=100')).find((t) => t.id === task.id && t.status === 'succeeded'), 30_000, prompt);
  return done.outputAssetIds[0];
}

/** 一章一场：3 个镜头（前两个有视频，第三个只有关键帧），2 句台词分别挂在第 1、2 个镜头 */
async function makeStory(client: Client, media: { v1?: string; v2?: string; k3?: string } = {}) {
  const story = await client.post('/api/stories', { title: '成片测试', logline: '' });
  const suffix = Math.random().toString(36).slice(2, 7);
  const ids = { ch: `ch_${suffix}`, sc: `sc_${suffix}`, c: `c_${suffix}`, d1: `d1_${suffix}`, d2: `d2_${suffix}`, s1: `s1_${suffix}`, s2: `s2_${suffix}`, s3: `s3_${suffix}` };
  const shot = (id: string, key: string, extra: Record<string, unknown>) => ({
    op: 'create', entity: 'shot', id, parentId: ids.sc, sortKey: key,
    value: { shotSize: '中景', cameraMove: '固定', description: `镜头 ${id}`, dialogueIds: [], duration: 2, characterIds: [], keyframeAssetId: null, videoAssetId: null, ...extra },
  });
  await client.post(`/api/stories/${story.id}/ops`, {
    ops: [
      { op: 'create', entity: 'character', id: ids.c, sortKey: 'i', value: { name: '林昔', appearance: '短发', voice: 'nova' } },
      { op: 'create', entity: 'chapter', id: ids.ch, sortKey: 'i', value: { title: '第一章', summary: '' } },
      { op: 'create', entity: 'scene', id: ids.sc, parentId: ids.ch, sortKey: 'i', value: { title: '雨夜', location: '', time: '', summary: '' } },
      { op: 'create', entity: 'line', id: ids.d1, parentId: ids.sc, sortKey: 'i', value: { characterId: ids.c, text: '你终于来了', emotion: '平静' } },
      { op: 'create', entity: 'line', id: ids.d2, parentId: ids.sc, sortKey: 'j', value: { characterId: null, text: '雨一直下着', emotion: '' } },
      shot(ids.s1, 'i', { dialogueIds: [ids.d1], videoAssetId: media.v1 ?? null }),
      shot(ids.s2, 'j', { dialogueIds: [ids.d2], videoAssetId: media.v2 ?? null }),
      shot(ids.s3, 'k', { keyframeAssetId: media.k3 ?? null }),
    ],
  });
  return { id: story.id as string, ...ids };
}

describe('M8b 成片与配音', () => {
  test('EXP-08 一键配音：没配置 TTS 时用模拟配音，写回台词；再次点击跳过已配的', async () => {
    assert.equal((await me.get('/api/tts')).mode, 'mock');
    const story = await makeStory(me);
    const started = await me.post(`/api/stories/${story.id}/voice`, {});
    assert.equal(started.count, 2);
    assert.equal(started.mode, 'mock');
    const job = await waitJob(me, started.job.id);
    assert.equal(job.status, 'succeeded', job.error ?? '');
    assert.deepEqual(job.result, { count: 2, mock: true });
    const after = await me.get(`/api/stories/${story.id}`);
    const lines = after.data.chapters[0].scenes[0].dialogue;
    assert.ok(lines.every((l: any) => l.voiceAssetId));
    const voice = await me.get(`/api/assets/${lines[0].voiceAssetId}`);
    assert.equal(voice.kind, 'audio');
    assert.equal(voice.purpose, 'voice');
    assert.ok(voice.duration > 0.5, `配音时长 ${voice.duration}`);
    const wav = await me.raw('GET', new URL(voice.url, h.base).pathname);
    assert.equal(Buffer.from(await wav.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
    // 已有配音的台词跳过；overwrite 才重新生成
    assert.equal((await me.raw('POST', `/api/stories/${story.id}/voice`, {})).status, 400);
    const again = await me.post(`/api/stories/${story.id}/voice`, { lineIds: [story.d2], overwrite: true });
    assert.equal(again.count, 1);
    await waitJob(me, again.job.id);
  });

  test('EXP-03 成片：试算 → 渲染；裁剪点生效、静帧补位、混入配音、版本号递增，带 AI 标识', { skip: !FFMPEG && '没有 ffmpeg' }, async () => {
    await h.scenario({ realMedia: true });
    const v1 = await generate(me, 't2v', '成片一', { ...VIDEO_PARAMS, duration: 2 });
    const v2 = await generate(me, 't2v', '成片二', { ...VIDEO_PARAMS, duration: 2 });
    const k3 = await generate(me, 't2i', '静帧', IMAGE_PARAMS);
    await h.scenario({ realMedia: false });
    const story = await makeStory(me, { v1, v2, k3 });
    await me.post(`/api/stories/${story.id}/ops`, { ops: [{ op: 'set', entity: 'shot', id: story.s1, patch: { trimIn: 0.5, trimOut: 1.5 } }] });
    await waitJob(me, (await me.post(`/api/stories/${story.id}/voice`, {})).job.id);

    const noStills = await me.post(`/api/stories/${story.id}/film/plan`, { stills: false });
    assert.equal(noStills.clips, 2);
    assert.equal(noStills.missing.length, 1);
    assert.equal(noStills.mode, 'reencode', '有裁剪点时要重编码');
    const plan = await me.post(`/api/stories/${story.id}/film/plan`, {});
    assert.equal(plan.clips, 3);
    assert.equal(plan.stills, 1);
    assert.equal(plan.voices, 2);
    assert.equal(plan.version, 1);
    // 第 1 段裁成 1 秒 + 第 2 段整段 + 静帧按镜头时长 2 秒
    const full = (await me.get(`/api/assets/${v2}`)).duration as number;
    const expected = 1 + full + 2;
    assert.ok(Math.abs(plan.duration - expected) < 0.3, `预计时长 ${plan.duration}，应为 ${expected}`);

    const started = await me.post(`/api/stories/${story.id}/film`, {});
    const job = await waitJob(me, started.job.id, 120_000);
    assert.equal(job.status, 'succeeded', job.error ?? '');
    const film = await me.get(`/api/assets/${job.result.assetId}`);
    assert.equal(film.purpose, 'film');
    assert.equal(film.kind, 'video');
    assert.ok(Math.abs(film.duration - expected) < 0.5, `成片时长 ${film.duration}，应为 ${expected}`);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream=codec_type', '-of', 'json', '-'], {
      input: Buffer.from(await (await me.raw('GET', new URL(film.url, h.base).pathname)).arrayBuffer()),
    });
    const info = JSON.parse(probe.stdout.toString());
    assert.ok(info.streams.some((s: any) => s.codec_type === 'audio'), '有混音后的音轨');
    assert.match(JSON.stringify(info.format?.tags ?? {}), /AIGC/);

    const second = await waitJob(me, (await me.post(`/api/stories/${story.id}/film`, { voice: false })).job.id, 120_000);
    assert.equal(second.result.version, 2);
    const films = await me.get<any[]>(`/api/stories/${story.id}/films`);
    assert.equal(films.length, 2);
  });

  test('EXP-04 故事包：导出 .weave.zip 再导入，所有 id 换新，素材复制一份并保持引用', async () => {
    const k3 = await generate(me, 't2i', '故事包里的关键帧', IMAGE_PARAMS);
    const story = await makeStory(me, { k3 });
    await waitJob(me, (await me.post(`/api/stories/${story.id}/voice`, {})).job.id);
    const zip = await me.raw('GET', `/api/stories/${story.id}/package`);
    assert.equal(zip.status, 200);
    assert.match(decodeURIComponent(zip.headers.get('content-disposition') ?? ''), /成片测试\.weave\.zip/);
    const bytes = Buffer.from(await zip.arrayBuffer());

    const other = await h.user();
    const imported = await other.raw('POST', '/api/stories/import', undefined, { 'content-type': 'application/zip' }).catch(() => null);
    assert.ok(imported, '空请求体也要有响应');
    const response = await fetch(`${h.base}/api/stories/import`, { method: 'POST', headers: { cookie: other.cookie, 'content-type': 'application/zip' }, body: bytes });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.imported.assets, 3, '1 张关键帧 + 2 段配音');
    assert.notEqual(result.id, story.id);
    const copy = await other.get(`/api/stories/${result.id}`);
    const scene = copy.data.chapters[0].scenes[0];
    assert.equal(scene.shots.length, 3);
    assert.ok(scene.shots.every((s: any) => ![story.s1, story.s2, story.s3].includes(s.id)), '镜头 id 换新');
    assert.equal(copy.data.characters[0].voice, 'nova');
    assert.equal(scene.dialogue[0].characterId, copy.data.characters[0].id, '台词的角色引用跟着改');
    assert.deepEqual(scene.shots[0].dialogueIds, [scene.dialogue[0].id]);
    const keyframe = await other.get(`/api/assets/${scene.shots[2].keyframeAssetId}`);
    assert.notEqual(keyframe.id, k3);
    assert.equal(keyframe.storyId, result.id);
    const voice = await other.get(`/api/assets/${scene.dialogue[1].voiceAssetId}`);
    assert.equal(voice.kind, 'audio');
    // 原故事的主人看不到导入者的素材，反之亦然
    assert.equal((await me.raw('GET', `/api/assets/${keyframe.id}`)).status, 404);

    const junk = await fetch(`${h.base}/api/stories/import`, { method: 'POST', headers: { cookie: other.cookie, 'content-type': 'application/zip' }, body: Buffer.from('not a zip') });
    assert.equal(junk.status, 400);
  });

  test('STY-15 审片备注：按时间点和镜头记录，标记已解决，别人的故事不可见', async () => {
    const story = await makeStory(me);
    const note = await me.post(`/api/stories/${story.id}/notes`, { shotId: story.s2, atSec: 2.4, text: '这里节奏太慢' });
    assert.equal(note.shotId, story.s2);
    assert.equal((await me.raw('POST', `/api/stories/${story.id}/notes`, { shotId: 'sh_other', text: 'x' })).status, 400);
    const resolved = await me.patch(`/api/stories/${story.id}/notes/${note.id}`, { resolved: true });
    assert.equal(resolved.resolved, true);
    assert.equal((await me.get<any[]>(`/api/stories/${story.id}/notes`)).length, 1);
    const stranger = await h.user();
    assert.equal((await stranger.raw('GET', `/api/stories/${story.id}/notes`)).status, 404);
    await me.json('DELETE', `/api/stories/${story.id}/notes/${note.id}`);
    assert.equal((await me.get<any[]>(`/api/stories/${story.id}/notes`)).length, 0);
  });
});
