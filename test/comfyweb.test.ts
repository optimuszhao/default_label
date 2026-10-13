// comfyweb 算子 + 调度器的端到端行为（对照假算子）
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { IMAGE_PARAMS, VIDEO_PARAMS, startHarness, until, type Client, type Harness } from './harness.ts';

let h: Harness;
let user: Client;

before(async () => {
  h = await startHarness();
  user = await h.user();
});
after(async () => h?.stop());
beforeEach(async () => {
  await fetch(`${h.operator}/__reset`, { method: 'POST' });
});

async function waitTask(id: string, statuses: string[], timeoutMs = 15_000) {
  return until(async () => {
    const tasks = await user.get<any[]>('/api/tasks');
    const task = tasks.find((t) => t.id === id);
    return task && statuses.includes(task.status) ? task : null;
  }, timeoutMs, `任务进入 ${statuses.join('/')}`);
}

describe('comfyweb', () => {
  test('文生图成功：产物落地为资产', async () => {
    const task = await user.post('/api/tasks', { type: 't2i', prompt: '橘猫', params: IMAGE_PARAMS });
    const done = await waitTask(task.id, ['succeeded', 'failed']);
    assert.equal(done.status, 'succeeded', done.lastError);
    assert.equal(done.outputAssetIds.length, 1);
    const assets = await user.get<any[]>('/api/assets');
    const asset = assets.find((a) => a.id === done.outputAssetIds[0]);
    assert.equal(asset.mime, 'image/png');
    const file = await user.raw('GET', `/api/files/${asset.id}`);
    assert.equal(file.status, 200);
  });

  test('一次出 3 张图（没锁种子）：合成 1 个上游任务（count=3），得到 3 个资产', async () => {
    const task = await user.post('/api/tasks', { type: 't2i', prompt: '多张', params: { ...IMAGE_PARAMS, count: 3 } });
    const done = await waitTask(task.id, ['succeeded', 'failed']);
    assert.equal(done.status, 'succeeded', done.lastError);
    assert.equal(done.outputAssetIds.length, 3);
    const sent = await h.operatorRequests();
    assert.equal(sent.length, 1);
    assert.equal((sent[0] as any).params.count, 3);
  });

  test('文生视频：只下载超分版，显示上游阶段', async () => {
    await h.scenario({ runningMs: 1500 });
    const task = await user.post('/api/tasks', { type: 't2v', prompt: '海浪', params: VIDEO_PARAMS });
    const running = await until(async () => {
      const t = (await user.get<any[]>('/api/tasks')).find((x) => x.id === task.id);
      return t?.stage === '视频生成中' ? t : null;
    }, 10_000, '出现阶段文字');
    assert.equal(running.status, 'running');
    const done = await waitTask(task.id, ['succeeded', 'failed']);
    assert.equal(done.status, 'succeeded', done.lastError);
    assert.equal(done.outputAssetIds.length, 1);
    const asset = (await user.get<any[]>('/api/assets')).find((a) => a.id === done.outputAssetIds[0]);
    assert.equal(asset.kind, 'video');
  });

  test('没有超分版时下载原片', async () => {
    await h.scenario({ outcome: 'no-upscale' });
    const task = await user.post('/api/tasks', { type: 't2v', prompt: '原片', params: VIDEO_PARAMS });
    const done = await waitTask(task.id, ['succeeded', 'failed']);
    assert.equal(done.status, 'succeeded', done.lastError);
  });

  test('提交时 503：不计失败，排队等待后自动重试成功', async () => {
    await h.scenario({ submitFailures: 1 });
    const task = await user.post('/api/tasks', { type: 't2i', prompt: '503', params: IMAGE_PARAMS });
    const waiting = await until(async () => {
      const t = (await user.get<any[]>('/api/tasks')).find((x) => x.id === task.id);
      return t?.waitReason ? t : null;
    }, 10_000, '进入等待');
    assert.equal(waiting.attempts, 0);
    await user.post('/api/queue/run-all');
    const done = await waitTask(task.id, ['succeeded', 'failed'], 20_000);
    assert.equal(done.status, 'succeeded', done.lastError);
    assert.equal(done.attempts, 1);
  });

  test('token 失效（401）：自动重新登录后继续', async () => {
    const first = await user.post('/api/tasks', { type: 't2i', prompt: '登录', params: IMAGE_PARAMS });
    await waitTask(first.id, ['succeeded']);
    await h.scenario({ unauthorized: 1 });
    const task = await user.post('/api/tasks', { type: 't2i', prompt: '过期', params: IMAGE_PARAMS });
    const done = await waitTask(task.id, ['succeeded', 'failed']);
    assert.equal(done.status, 'succeeded', done.lastError);
  });

  test('生成失败：记录上游错误并退避重试', async () => {
    await h.scenario({ outcome: 'fail' });
    const task = await user.post('/api/tasks', { type: 't2i', prompt: '失败', params: IMAGE_PARAMS });
    const retried = await until(async () => {
      const t = (await user.get<any[]>('/api/tasks')).find((x) => x.id === task.id);
      return t?.status === 'queued' && t.lastError ? t : null;
    }, 10_000, '失败后排队重试');
    assert.match(retried.lastError, /显存不足/);
    assert.equal(retried.attempts, 1);
    assert.ok(retried.nextAttemptAt > Date.now() + 5_000);
  });

  test('产物文件丢失：任务失败而不是挂起', async () => {
    await h.scenario({ outcome: 'missing-file' });
    const task = await user.post('/api/tasks', { type: 't2i', prompt: '丢失', params: IMAGE_PARAMS });
    const retried = await until(async () => {
      const t = (await user.get<any[]>('/api/tasks')).find((x) => x.id === task.id);
      return t?.lastError ? t : null;
    }, 10_000, '记录错误');
    assert.match(retried.lastError, /找不到产物/);
  });
});
