// M6 资产库 2.0：衍生文件、回收站、组织、搜索、详情与血缘、分片上传、打包下载、存储统计与去重、截帧
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { crc32 } from 'node:zlib';
import { makePng } from '../scripts/fake-operator.ts';
import { type Client, type Harness, IMAGE_PARAMS, startHarness, until } from './harness.ts';

const ADMIN = 'admin@library.test';
const FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

let h: Harness;
let user: Client;

before(async () => {
  h = await startHarness({ ADMIN_EMAILS: ADMIN });
  user = await h.user();
});
after(async () => h?.stop());

async function generate(client: Client, prompt: string, count = 1): Promise<string[]> {
  const task = await client.post('/api/tasks', { type: 't2i', prompt, params: { ...IMAGE_PARAMS, count } });
  const done = await until(async () => {
    const t = (await client.get<any[]>('/api/tasks')).find((x) => x.id === task.id);
    return t?.status === 'succeeded' ? t : null;
  }, 30_000, '生成完成');
  return done.outputAssetIds as string[];
}

/** 给 PNG 插一个 tEXt 块（模拟 ComfyUI 写入的生成参数） */
function pngWithText(key: string, value: string): Buffer {
  const png = makePng(16, 16);
  const data = Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]);
  const type = Buffer.from('tEXt', 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  // 签名 8 字节 + IHDR（4+4+13+4 = 25 字节）之后插入
  return Buffer.concat([png.subarray(0, 33), length, type, data, crc, png.subarray(33)]);
}

async function uploadChunks(client: Client, name: string, mime: string, data: Buffer, chunk = 7): Promise<any> {
  const start = await client.post('/api/uploads', { filename: name, mime, size: data.length });
  let offset = start.received as number;
  while (offset < data.length) {
    const piece = data.subarray(offset, offset + chunk);
    const response = await fetch(`${client.base}/api/uploads/${start.id}?offset=${offset}`, {
      method: 'PUT',
      headers: { cookie: client.cookie, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(piece),
    });
    assert.equal(response.status, 200, await response.clone().text());
    offset = ((await response.json()) as { received: number }).received;
  }
  return client.post(`/api/uploads/${start.id}/complete`, {});
}

function makeVideo(seconds = 2): Buffer {
  const file = path.join(os.tmpdir(), `weave-test-${process.pid}-${Date.now()}.mp4`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=24:duration=${seconds}`, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', file]);
  const data = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return data;
}

function openDb(): DatabaseSync {
  return new DatabaseSync(path.join(h.dataDir, 'weave.db'));
}

describe('M6 资产库 2.0', () => {
  test('AST-02 资产补齐大小、哈希和序号；AST-03 后台生成缩略图', async () => {
    const [id] = await generate(user, '衍生文件');
    const asset = await until(async () => {
      const a = await user.get(`/api/assets/${id}`);
      return a.size && (!FFMPEG || a.thumbUrl.includes('variant=thumb')) ? a : null;
    }, 20_000, '衍生文件');
    assert.ok(asset.size > 0);
    const detail = await user.get(`/api/assets/${id}/detail`);
    assert.match(detail.sha256, /^[0-9a-f]{64}$/);
    if (FFMPEG) {
      const thumb = await user.raw('GET', asset.thumbUrl);
      assert.equal(thumb.status, 200);
      assert.equal(thumb.headers.get('content-type'), 'image/webp');
    }
  });

  test('AST-05 回收站：删除进回收站、可恢复；被排队任务使用的素材不能删；再删彻底删除', async () => {
    const [a, b] = await generate(user, '回收站', 2);
    // 被排队任务引用：关闭自动调度的用户提交一个以 a 为参考的图生图，任务会一直排队
    const idle = await h.user(undefined, { autoDispatch: false });
    const [own] = await generate(user, '自己的'); // 先确认别人的素材不能拿来用
    const refused = await idle.raw('POST', '/api/tasks', { type: 'i2i', prompt: 'x', params: IMAGE_PARAMS, inputs: { referenceAssetIds: [own] } });
    assert.equal(refused.status, 400);
    await user.patch('/api/settings', { autoDispatch: false });
    const queued = await user.post('/api/tasks', { type: 'i2i', prompt: '排队', params: IMAGE_PARAMS, inputs: { referenceAssetIds: [a] } });
    assert.equal(queued.status, 'queued');
    const blocked = await user.raw('DELETE', `/api/assets/${a}`);
    assert.equal(blocked.status, 409);
    await user.post(`/api/tasks/${queued.id}/cancel`);
    await user.patch('/api/settings', { autoDispatch: true });

    const del = await user.raw('DELETE', `/api/assets/${b}`);
    assert.equal(del.status, 200);
    let list = await user.get<any[]>('/api/assets?limit=200');
    assert.ok(!list.some((x) => x.id === b), '删除后不在列表里');
    const trash = await user.get<any[]>('/api/assets?trash=1');
    assert.ok(trash.some((x) => x.id === b && x.deletedAt), '在回收站里');
    // 回收站里的素材不能再用来生成
    const reuse = await user.raw('POST', '/api/tasks', { type: 'i2i', prompt: 'x', params: IMAGE_PARAMS, inputs: { referenceAssetIds: [b] } });
    assert.equal(reuse.status, 400);
    await user.post('/api/assets/batch', { ids: [b], action: 'restore' });
    list = await user.get<any[]>('/api/assets?limit=200');
    assert.ok(list.some((x) => x.id === b), '恢复后回到列表');
    // 再删两次：第二次彻底删除，文件也没了
    await user.raw('DELETE', `/api/assets/${b}`);
    const purge = await user.raw('DELETE', `/api/assets/${b}`);
    assert.equal(purge.status, 200);
    assert.equal((await user.raw('GET', `/api/assets/${b}`)).status, 404);
  });

  test('AST-05 回收站超过保留天数自动清除', async () => {
    const admin = await h.user(ADMIN);
    const [id] = await generate(admin, '过期');
    await admin.raw('DELETE', `/api/assets/${id}`);
    const db = openDb();
    db.prepare('UPDATE assets SET deleted_at = ? WHERE id = ?').run(Date.now() - 31 * 86_400_000, id);
    db.close();
    const result = await admin.post('/api/admin/library/cleanup');
    assert.ok(result.purged >= 1);
    assert.equal((await admin.raw('GET', `/api/assets/${id}`)).status, 404);
  });

  test('AST-06 组织：文件夹最多 4 层、含子文件夹查询、标签、评分、标记、按条件批量', async () => {
    const org = await h.user();
    const ids = await generate(org, '组织', 4);
    const l1 = await org.post('/api/folders', { name: '项目' });
    const l2 = await org.post('/api/folders', { name: '第一集', parentId: l1.id });
    const l3 = await org.post('/api/folders', { name: '场景', parentId: l2.id });
    const l4 = await org.post('/api/folders', { name: '雨夜', parentId: l3.id });
    const tooDeep = await org.raw('POST', '/api/folders', { name: '太深', parentId: l4.id });
    assert.equal(tooDeep.status, 400);
    // 不能移到自己的子文件夹里
    assert.equal((await org.raw('PATCH', `/api/folders/${l1.id}`, { parentId: l3.id })).status, 400);

    await org.patch(`/api/assets/${ids[0]}`, { folderId: l3.id, rating: 4, flag: 'pick', tags: ['女主', '雨夜'] });
    await org.post('/api/assets/batch', { ids: [ids[1], ids[2]], action: 'move', value: l1.id });
    const inProject = await org.get<any[]>(`/api/assets?folder=${l1.id}`);
    assert.deepEqual(new Set(inProject.map((x) => x.id)), new Set([ids[0], ids[1], ids[2]]), '查上级文件夹包含子文件夹里的素材');
    const unfiled = await org.get<any[]>('/api/assets?unfiled=1');
    assert.deepEqual(unfiled.map((x) => x.id), [ids[3]]);

    // 按查询条件全选：给"项目"里所有素材加标签
    const result = await org.post('/api/assets/batch', { query: { folder: l1.id }, action: 'addTags', value: ['第一集'] });
    assert.equal(result.count, 3);
    const tags = await org.get<any[]>('/api/tags');
    assert.equal(tags.find((t) => t.name === '第一集').count, 3);
    const tagged = await org.get<any[]>(`/api/assets?tag=${tags.find((t) => t.name === '女主').id}`);
    assert.deepEqual(tagged.map((x) => x.id), [ids[0]]);
    assert.deepEqual(tagged[0].tags.sort(), ['女主', '第一集', '雨夜'].sort());

    const picks = await org.get<any[]>('/api/assets?flag=pick&minRating=4');
    assert.deepEqual(picks.map((x) => x.id), [ids[0]]);
    const facets = await org.get('/api/assets/facets');
    assert.equal(facets.total, 4);
    assert.equal(facets.flags.pick, 1);
    assert.equal(facets.ratings['4'], 1);

    // 智能文件夹
    const saved = await org.post('/api/saved-searches', { name: '高分', query: { minRating: 4 } });
    assert.ok((await org.get<any[]>('/api/saved-searches')).some((s) => s.id === saved.id));

    // 删除文件夹：素材变成未归档
    await org.raw('DELETE', `/api/folders/${l1.id}`);
    assert.equal((await org.get<any[]>('/api/assets?unfiled=1')).length, 4);
    assert.equal((await org.get<any[]>('/api/folders')).length, 0);
  });

  test('AST-07 搜索：长词走全文索引，两个字的词也能命中；备注和标签可搜', async () => {
    const s = await h.user();
    const [cyber] = await generate(s, '赛博朋克雨夜霓虹街头');
    const [ramen] = await generate(s, '深夜的拉面店');
    assert.deepEqual((await s.get<any[]>(`/api/assets?q=${encodeURIComponent('赛博朋克')}`)).map((x) => x.id), [cyber]);
    assert.deepEqual((await s.get<any[]>(`/api/assets?q=${encodeURIComponent('拉面')}`)).map((x) => x.id), [ramen]);
    await s.patch(`/api/assets/${ramen}`, { note: '用作第三集封面', tags: ['美食'] });
    assert.deepEqual((await s.get<any[]>(`/api/assets?q=${encodeURIComponent('第三集封面')}`)).map((x) => x.id), [ramen]);
    assert.deepEqual((await s.get<any[]>(`/api/assets?q=${encodeURIComponent('美食')}`)).map((x) => x.id), [ramen]);
    // 新版分页
    const page = await s.get(`/api/assets?page=1&limit=1`);
    assert.equal(page.items.length, 1);
    const page2 = await s.get(`/api/assets?page=1&limit=1&cursor=${page.next}`);
    assert.equal(page2.items.length, 1);
    assert.notEqual(page2.items[0].id, page.items[0].id);
  });

  test('AST-11 分片上传：断点续传、顺序校验、相同文件去重、读取 PNG 里的生成参数', async () => {
    const up = await h.user();
    const comfy = JSON.stringify({ '3': { class_type: 'KSampler', inputs: { seed: 1234 } }, '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat on the moon' } } });
    const png = pngWithText('prompt', comfy);
    const start = await up.post('/api/uploads', { filename: '月亮猫.png', mime: 'image/png', size: png.length });
    // 跳过分片：409，并告诉客户端已经收到多少
    const skip = await fetch(`${up.base}/api/uploads/${start.id}?offset=10`, {
      method: 'PUT',
      headers: { cookie: up.cookie, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(png.subarray(10, 20)),
    });
    assert.equal(skip.status, 409);
    assert.equal(((await skip.json()) as { received: number }).received, 0);
    // 传一半后"断线"，查询进度后继续
    await fetch(`${up.base}/api/uploads/${start.id}?offset=0`, {
      method: 'PUT',
      headers: { cookie: up.cookie, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(png.subarray(0, 50)),
    });
    const progress = await up.get(`/api/uploads/${start.id}`);
    assert.equal(progress.received, 50);
    await fetch(`${up.base}/api/uploads/${start.id}?offset=50`, {
      method: 'PUT',
      headers: { cookie: up.cookie, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(png.subarray(50)),
    });
    const done = await up.post(`/api/uploads/${start.id}/complete`, {});
    assert.equal(done.duplicate, false);
    assert.equal(done.asset.filename, '月亮猫.png');
    assert.equal(done.asset.prompt, 'a cat on the moon');
    const detail = await up.get(`/api/assets/${done.asset.id}/detail`);
    assert.equal(detail.meta.png.seed, 1234);

    const again = await uploadChunks(up, '副本.png', 'image/png', png);
    assert.equal(again.duplicate, true);
    assert.equal(again.asset.id, done.asset.id);

    // 音频
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40)]);
    const audio = await uploadChunks(up, '配音.wav', 'audio/wav', wav, 16);
    assert.equal(audio.asset.kind, 'audio');
    assert.equal((await up.raw('POST', '/api/uploads', { filename: 'x.exe', mime: 'application/x-msdownload', size: 10 })).status, 400);
  });

  test('AST-12 打包下载：流式 zip，附带 manifest.json', async () => {
    const z = await h.user();
    const ids = await generate(z, '打包', 2);
    const { url, count } = await z.post('/api/assets/export', { ids, name: '测试包' });
    assert.equal(count, 2);
    const response = await z.raw('GET', url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.match(response.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/);
    const zip = Buffer.from(await response.arrayBuffer());
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.equal(zip.readUInt16LE(eocd + 10), 3, '两个文件加 manifest.json');
    assert.ok(zip.includes(Buffer.from('manifest.json')));
    const tmp = path.join(os.tmpdir(), `weave-zip-${process.pid}.zip`);
    fs.writeFileSync(tmp, zip);
    if (spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0) {
      assert.equal(spawnSync('unzip', ['-tq', tmp]).status, 0, 'unzip 校验通过');
    }
    fs.rmSync(tmp, { force: true });
  });

  test('AST-13 存储统计与合并重复文件（引用改指向保留的那份）', async () => {
    const st = await h.user();
    const [keep, dup] = await generate(st, '重复', 2);
    await until(async () => (await st.get(`/api/assets/${dup}/detail`)).sha256, 10_000, '哈希');
    const story = await st.post('/api/stories', { title: '引用测试', logline: '' });
    await st.post(`/api/stories/${story.id}/ops`, {
      ops: [{ op: 'create', entity: 'character', id: 'c_1', sortKey: 'i', value: { name: '甲', role: '主角', referenceAssetId: dup } }],
    });
    const db = openDb();
    const sha = (db.prepare('SELECT sha256 FROM assets WHERE id = ?').get(keep) as { sha256: string }).sha256;
    db.prepare('UPDATE assets SET sha256 = ?, rating = 5 WHERE id = ?').run(sha, dup);
    db.close();
    const usage = await st.get('/api/storage/usage');
    assert.equal(usage.total.count, 2);
    assert.equal(usage.duplicates.groups, 1);
    const groups = await st.get<any[]>('/api/assets/duplicates');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].keepId, dup, '有评分的优先保留');
    const merged = await st.post('/api/assets/duplicates/merge', {});
    assert.equal(merged.removed, 1);
    assert.equal((await st.raw('GET', `/api/assets/${keep}`)).status, 404);
    const after = await st.get(`/api/stories/${story.id}`);
    assert.equal(after.data.characters[0].referenceAssetId, dup);
  });

  test('AST-08 详情与使用情况；AST-14 视频截帧为新素材，血缘记为 frame', { skip: !FFMPEG && '没有 ffmpeg' }, async () => {
    const fr = await h.user();
    const video = await uploadChunks(fr, '测试视频.mp4', 'video/mp4', makeVideo(2), 64 * 1024);
    assert.equal(video.asset.kind, 'video');
    const ready = await until(async () => {
      const a = await fr.get(`/api/assets/${video.asset.id}`);
      return a.posterUrl ? a : null;
    }, 20_000, '视频封面');
    assert.ok(ready.duration > 1.5);
    const frame = await fr.post(`/api/assets/${video.asset.id}/frame`, { at: 1 });
    assert.equal(frame.kind, 'image');
    assert.equal(frame.parentAssetId, video.asset.id);
    assert.equal(frame.lineage, 'frame');
    assert.equal(frame.width, 320);
    const last = await fr.post(`/api/assets/${video.asset.id}/frame`, { at: 'last' });
    assert.equal(last.lineage, 'frame');
    const lineage = await fr.get(`/api/assets/${video.asset.id}/lineage`);
    assert.equal(lineage.children.length, 2);
    const up = await fr.get(`/api/assets/${frame.id}/lineage`);
    assert.equal(up.parents[0].id, video.asset.id);
    // 使用情况：被故事角色引用
    const story = await fr.post('/api/stories', { title: '用到截帧', logline: '' });
    await fr.post(`/api/stories/${story.id}/ops`, {
      ops: [{ op: 'create', entity: 'character', id: 'c_x', sortKey: 'i', value: { name: '乙', role: '主角', referenceAssetId: frame.id } }],
    });
    const usage = await fr.get(`/api/assets/${frame.id}/usage`);
    assert.equal(usage.stories.length, 1);
    assert.match(usage.stories[0].where, /乙/);
    const detail = await fr.get(`/api/assets/${video.asset.id}/detail`);
    assert.equal(detail.codec, 'h264');
  });
});
