// M0a · SCH-01 / SCH-02：调度器缺陷的回归测试
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import { makePng } from '../scripts/fake-operator.ts';
import { IMAGE_PARAMS, VIDEO_PARAMS, sleep, startHarness, until, type Client, type Harness } from './harness.ts';

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

async function task(client: Client, id: string) {
  return (await client.get<any[]>('/api/tasks')).find((t) => t.id === id);
}

async function waitStatus(client: Client, id: string, statuses: string[], timeoutMs = 15_000) {
  return until(async () => {
    const t = await task(client, id);
    return t && statuses.includes(t.status) ? t : null;
  }, timeoutMs, `任务进入 ${statuses.join('/')}`);
}

function peakRssMb(pid: number): number {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  return Number(/VmHWM:\s+(\d+)/.exec(status)![1]) / 1024;
}

describe('种子', () => {
  test('不指定种子：服务端生成随机种子，不再提交 0，并记录到资产', async () => {
    const first = await user.post('/api/tasks', { type: 't2i', prompt: '种子', params: { ...IMAGE_PARAMS, count: 3 } });
    const done = await waitStatus(user, first.id, ['succeeded', 'failed']);
    assert.equal(done.status, 'succeeded', done.lastError);
    const sent = (await h.operatorRequests()).map((r) => r.params.seed as number);
    assert.equal(sent.length, 3);
    assert.ok(sent.every((seed) => seed > 0), `提交的种子：${sent}`);
    assert.deepEqual(sent, [sent[0], sent[0] + 1, sent[0] + 2]);
    const assets = await user.get<any[]>('/api/assets');
    const seeds = done.outputAssetIds.map((id: string) => assets.find((a) => a.id === id).gen.seed);
    assert.deepEqual(seeds, sent);

    // 再来一次：换一个新种子
    const again = await user.post(`/api/tasks/${first.id}/retry`);
    await waitStatus(user, again.id, ['succeeded']);
    const second = (await h.operatorRequests()).slice(3).map((r) => r.params.seed);
    assert.notEqual(second[0], sent[0]);
  });

  test('指定种子时原样提交', async () => {
    const t = await user.post('/api/tasks', { type: 't2i', prompt: '固定', params: { ...IMAGE_PARAMS, seed: 42 } });
    await waitStatus(user, t.id, ['succeeded']);
    assert.equal((await h.operatorRequests())[0].params.seed, 42);
  });
});

describe('下载', () => {
  test('大视频流式落盘：内存不随文件变大，期间图片任务照常完成，记录超分后的真实尺寸', async () => {
    // 先下一个 40 MB 的视频预热（首次下载会分配一批缓冲区），再测 80 MB 的峰值增量
    await h.scenario({ videoSizeMb: 40 });
    const warm = await user.post('/api/tasks', { type: 't2v', prompt: '预热', params: VIDEO_PARAMS });
    await waitStatus(user, warm.id, ['succeeded'], 30_000);
    await fetch(`${h.operator}/__reset`, { method: 'POST' });
    await h.scenario({ videoSizeMb: 80, videoDownloadDelayMs: 2500 });
    const baseline = peakRssMb(h.pid);
    const video = await user.post('/api/tasks', { type: 't2v', prompt: '大视频', params: VIDEO_PARAMS });
    await until(async () => (await h.operatorRequests()).length === 1, 5_000, '视频提交');
    // 等视频进入下载阶段后再提交图片
    await sleep(1500);
    const image = await user.post('/api/tasks', { type: 't2i', prompt: '插队的图', params: IMAGE_PARAMS });
    const imageDone = await waitStatus(user, image.id, ['succeeded', 'failed'], 10_000);
    assert.equal(imageDone.status, 'succeeded');
    assert.equal((await task(user, video.id)).status, 'running', '图片完成时视频应仍在下载');
    const videoDone = await waitStatus(user, video.id, ['succeeded', 'failed'], 30_000);
    assert.equal(videoDone.status, 'succeeded', videoDone.lastError);
    const growth = peakRssMb(h.pid) - baseline;
    assert.ok(growth < 30, `内存峰值增长 ${growth.toFixed(1)} MB`);
    const asset = (await user.get<any[]>('/api/assets')).find((a) => a.id === videoDone.outputAssetIds[0]);
    assert.equal(asset.width, 2688);
    assert.equal(asset.height, 1536);
    assert.equal(asset.duration, 5);
    const file = await user.raw('GET', `/api/files/${asset.id}`);
    assert.equal(Number(file.headers.get('content-length')), 80 * 1024 * 1024);
  });

  test('产物在其他主机上：下载时不带 token', async () => {
    const seen: (string | undefined)[] = [];
    const other = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(makePng(64, 64));
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const port = (other.address() as { port: number }).port;
    try {
      await h.scenario({ resultBase: `http://127.0.0.1:${port}` });
      const t = await user.post('/api/tasks', { type: 't2i', prompt: '外链', params: IMAGE_PARAMS });
      const done = await waitStatus(user, t.id, ['succeeded', 'failed']);
      assert.equal(done.status, 'succeeded', done.lastError);
      assert.equal(seen.length, 1);
      assert.equal(seen[0], undefined);
    } finally {
      other.close();
    }
  });
});

describe('取消', () => {
  test('提交过程中取消：任务不会被复活', async () => {
    await h.scenario({ submitDelayMs: 1500 });
    const t = await user.post('/api/tasks', { type: 't2i', prompt: '取消', params: IMAGE_PARAMS });
    await until(async () => (await h.operatorRequests()).length === 1, 5_000, '开始提交');
    await user.post(`/api/tasks/${t.id}/cancel`);
    await sleep(3000);
    const after = await task(user, t.id);
    assert.equal(after.status, 'canceled');
    assert.equal(after.outputAssetIds.length, 0);
  });

  test('下载过程中取消：不会被标成已完成，也不留下资产', async () => {
    await h.scenario({ videoDownloadDelayMs: 2000 });
    const before = (await user.get<any[]>('/api/assets')).length;
    const t = await user.post('/api/tasks', { type: 't2v', prompt: '取消下载', params: VIDEO_PARAMS });
    await waitStatus(user, t.id, ['running']);
    await sleep(1600); // 假算子 1.2 秒后完成，此时正在下载
    await user.post(`/api/tasks/${t.id}/cancel`);
    await sleep(3000);
    assert.equal((await task(user, t.id)).status, 'canceled');
    assert.equal((await user.get<any[]>('/api/assets')).length, before);
  });
});

describe('服务状态', () => {
  test('服务不可用时“立即运行”的标记不会被清掉', async () => {
    const manual = await h.user(undefined, { autoDispatch: false });
    await h.scenario({ health: '503' });
    await sleep(300);
    const t = await manual.post('/api/tasks', { type: 't2i', prompt: '手动', params: IMAGE_PARAMS, runNow: true });
    const waiting = await until(async () => {
      const x = await task(manual, t.id);
      return x?.waitReason ? x : null;
    }, 5_000, '进入等待');
    assert.equal(waiting.manualKick, true);
    await h.scenario({ health: 'ok' });
    // 等待间隔到了以后自动重试（用户设置的间隔是 5 秒）
    const done = await waitStatus(manual, t.id, ['succeeded', 'failed'], 15_000);
    assert.equal(done.status, 'succeeded');
  });

  test('对方没有 /health 接口时改用 verify 判断在线', async () => {
    await h.scenario({ health: '404' });
    const health = await user.post('/api/health/refresh');
    assert.equal(health.image, true, health.message);
  });

  test('未登录访问 /api/health 只返回布尔值', async () => {
    await h.scenario({ health: '503' });
    await user.post('/api/health/refresh');
    const anonymous = await (await fetch(`${h.base}/api/health`)).json();
    assert.equal(anonymous.image, false);
    assert.equal(anonymous.message, undefined);
    const mine = await user.get('/api/health');
    assert.ok(mine.message);
  });
});
