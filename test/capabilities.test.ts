// M0a · CRT-01 / OPR-08 v0：能力声明与服务端参数规整
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { makePng } from '../scripts/fake-operator.ts';
import { IMAGE_PARAMS, startHarness, until, type Client, type Harness } from './harness.ts';

let h: Harness;
let user: Client;

before(async () => {
  h = await startHarness();
  user = await h.user();
});
after(async () => h?.stop());

async function upload(client: Client): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(makePng(32, 32))], { type: 'image/png' }), 'ref.png');
  const response = await client.raw('POST', '/api/assets/upload', form);
  assert.equal(response.status, 200);
  return (await response.json()).id;
}

test('comfyweb 声明的能力：单张参考图、无尾帧、视频原生尺寸', async () => {
  const caps = await user.get('/api/capabilities');
  assert.equal(caps.operator, 'comfyweb');
  assert.equal(caps.image.maxReferences, 1);
  assert.equal(caps.image.strength, true, '图生图支持重绘强度（denoise）');
  assert.equal(caps.video.strength, false);
  assert.equal(caps.video.lastFrame, false);
  assert.equal(caps.video.negativePrompt, false);
  assert.deepEqual(caps.video.sizes.find((s: any) => s.aspectRatio === '16:9'), { aspectRatio: '16:9', width: 1344, height: 768 });
  const anonymous = await fetch(`${h.base}/api/capabilities`);
  assert.equal(anonymous.status, 401);
});

test('服务端兜底规整：多余参考图、CFG 被去掉，重绘强度保留', async () => {
  const a = await upload(user);
  const b = await upload(user);
  const task = await user.post('/api/tasks', {
    type: 'i2i',
    prompt: '规整',
    params: { ...IMAGE_PARAMS, strength: 0.5, cfg: 7, count: 2 },
    inputs: { referenceAssetIds: [a, b] },
  });
  assert.deepEqual(task.inputs.referenceAssetIds, [a]);
  assert.equal(task.params.strength, 0.5);
  assert.equal(task.params.cfg, undefined);
  assert.equal(task.params.count, 2);
});

test('16:9 视频按原生尺寸 1344×768 提交，时长收进 4–15 秒，去掉负向词', async () => {
  const task = await user.post('/api/tasks', {
    type: 't2v',
    prompt: '海边',
    negativePrompt: '模糊',
    params: { aspectRatio: '16:9', resolution: '1080p', width: 1920, height: 1088, count: 1, seed: null, duration: 20, steps: 30 },
  });
  assert.equal(task.params.width, 1344);
  assert.equal(task.params.height, 768);
  assert.equal(task.params.duration, 15);
  assert.equal(task.params.steps, undefined);
  assert.equal(task.negativePrompt, '');
  await until(async () => (await h.operatorRequests()).find((r) => r.path.endsWith('text2video')), 10_000, '提交到算子');
  const sent = (await h.operatorRequests()).find((r) => r.path.endsWith('text2video'))!;
  assert.equal(sent.params.width, 1344);
  assert.equal(sent.params.height, 768);
  assert.equal(sent.params.duration, 15);
});
