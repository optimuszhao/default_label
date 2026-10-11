// M7a 故事数据层：拆表迁移、增量 ops、其他设备同步、历史版本
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { applyStoryOps, bulkKeys, diffStory, keyBetween, type SortKeys } from '../shared/story-ops.ts';
import type { StoryData } from '../shared/types.ts';
import { snapshotsToPrune } from '../server/stories/retention.ts';
import { type Client, type Harness, startHarness } from './harness.ts';

let h: Harness;
let user: Client;

before(async () => {
  h = await startHarness();
  user = await h.user();
});
after(async () => h?.stop());

function legacyData(): StoryData {
  return {
    logline: '少女在雨夜寻找失踪的哥哥',
    genre: '悬疑',
    tone: '压抑',
    visualStyle: '赛博朋克',
    aspectRatio: '9:16',
    outline: '第一幕……第二幕……',
    negativePrompt: '模糊',
    characters: [
      { id: 'c_a', name: '林昔', role: '主角', appearance: '短发，红色雨衣', personality: '倔强', referenceAssetId: null },
      { id: 'c_b', name: '林昊', role: '配角', appearance: '', personality: '', referenceAssetId: null },
    ],
    chapters: [
      {
        id: 'ch_1',
        title: '第一章',
        summary: '开端',
        scenes: [
          {
            id: 'sc_1',
            title: '雨夜街头',
            location: '旧城区',
            time: '夜',
            summary: '林昔撑伞走过霓虹',
            dialogue: [
              { id: 'd_1', characterId: 'c_a', text: '哥哥，你在哪？', emotion: '焦急' },
              { id: 'd_2', characterId: null, text: '雨越下越大。', emotion: '' },
            ],
            shots: [
              { id: 'sh_1', shotSize: '远景', cameraMove: '推', description: '雨夜街头全景', dialogueIds: [], duration: 4, characterIds: [], keyframeAssetId: null, videoAssetId: null },
              { id: 'sh_2', shotSize: '近景', cameraMove: '固定', description: '林昔回头', dialogueIds: ['d_1'], duration: 6, characterIds: ['c_a'], keyframeAssetId: null, videoAssetId: null },
            ],
          },
        ],
      },
    ],
  };
}

function openDb(): DatabaseSync {
  return new DatabaseSync(path.join(h.dataDir, 'weave.db'));
}

/** 直接往库里塞一个旧格式（schema=1）的故事 */
function insertLegacy(userEmailClient: Client, data: unknown, id: string): Promise<void> {
  return userEmailClient.get('/api/auth/me').then(({ user: me }) => {
    const db = openDb();
    db.prepare("INSERT INTO stories (id, user_id, title, data, schema, rev, created_at, updated_at) VALUES (?, ?, '旧故事', ?, 1, 7, ?, ?)").run(id, me.id, JSON.stringify(data), Date.now(), Date.now());
    db.close();
  });
}

async function edit(client: Client, id: string, change: (draft: { title: string; data: StoryData }) => void, clientId = 'test'): Promise<{ rev: number; ignored: unknown[]; story: any }> {
  const story = await client.get(`/api/stories/${id}`);
  const keys: SortKeys = new Map(Object.entries(story.keys ?? {}));
  const before = { title: story.title, data: story.data as StoryData };
  const after = structuredClone(before);
  change(after);
  const ops = diffStory(before, after, keys);
  const result = await client.post(`/api/stories/${id}/ops`, { baseRev: story.rev, clientId, ops });
  return { ...result, story };
}

describe('M7a 故事数据层', () => {
  test('STY-05 排序键：任意两键之间都能插入，批量键按顺序', () => {
    let keys = bulkKeys(50);
    assert.deepEqual([...keys].sort(), keys);
    for (let i = 0; i < 200; i++) {
      const mid = keyBetween(keys[0], keys[1]);
      assert.ok(keys[0] < mid && mid < keys[1], `${keys[0]} < ${mid} < ${keys[1]}`);
      keys = [keys[0], mid, ...keys.slice(1)];
    }
    assert.ok(keyBetween(null, 'a') < 'a');
    assert.ok(keyBetween('z', null) > 'z');
  });

  test('STY-05 差异和应用互逆：改字段、新建、删除、重排都能还原；移动只发不在最长递增子序列里的元素', () => {
    const base = { title: '标题', data: legacyData() };
    const keys: SortKeys = new Map();
    const seed = diffStory({ title: '', data: { ...legacyData(), characters: [], chapters: [] } }, base, keys);
    assert.ok(seed.some((op) => op.op === 'create' && op.entity === 'shot'));
    const next = structuredClone(base);
    next.title = '新标题';
    next.data.chapters[0].scenes[0].shots.reverse();
    next.data.chapters[0].scenes[0].shots[0].description = '改过的描述';
    next.data.chapters[0].scenes[0].dialogue.push({ id: 'd_3', characterId: 'c_b', text: '我在这里', emotion: '' });
    next.data.characters.splice(1, 1);
    const ops = diffStory(base, next, keys);
    assert.equal(ops.filter((op) => op.op === 'move').length, 1, '两个元素互换只需移动一个');
    const applied = applyStoryOps(base, ops, new Map(keys));
    assert.equal(applied.title, '新标题');
    assert.deepEqual(applied.data.chapters[0].scenes[0].shots.map((s) => s.id), ['sh_2', 'sh_1']);
    assert.equal(applied.data.chapters[0].scenes[0].shots[1].description, '雨夜街头全景');
    assert.equal(applied.data.chapters[0].scenes[0].shots[0].description, '改过的描述');
    assert.equal(applied.data.characters.length, 1);
    assert.equal(applied.data.chapters[0].scenes[0].dialogue.length, 3);
    // 删掉整个场次：只发一条删除
    const removed = structuredClone(next);
    removed.data.chapters[0].scenes = [];
    const delOps = diffStory(next, removed, keys);
    assert.deepEqual(delOps.map((op) => `${op.op}:${op.entity}`), ['delete:scene']);
  });

  test('STY-04 旧故事打开时按需迁移：保留全部 id，读回一致，留一份原始 JSON 快照', async () => {
    await insertLegacy(user, legacyData(), 's_legacy1');
    const story = await user.get('/api/stories/s_legacy1');
    assert.equal(story.readOnly, undefined);
    assert.equal(story.data.chapters[0].scenes[0].shots[1].id, 'sh_2');
    assert.deepEqual(story.data.chapters[0].scenes[0].shots[1].characterIds, ['c_a']);
    assert.deepEqual(story.data.chapters[0].scenes[0].shots[1].dialogueIds, ['d_1']);
    assert.equal(story.data.characters[0].appearance, '短发，红色雨衣');
    assert.equal(story.data.outline, '第一幕……第二幕……');
    assert.equal(story.data.negativePrompt, '模糊');
    assert.equal(story.rev, 8);
    const db = openDb();
    assert.equal((db.prepare('SELECT schema FROM stories WHERE id = ?').get('s_legacy1') as { schema: number }).schema, 2);
    db.close();
    const snapshots = await user.get<any[]>('/api/stories/s_legacy1/snapshots');
    const original = snapshots.find((s) => s.reason === 'migration');
    assert.ok(original?.pinned);
    const preview = await user.get(`/api/stories/s_legacy1/snapshots/${original.id}`);
    assert.equal(preview.data.chapters[0].scenes[0].shots.length, 2);
    // 列表显示镜头数
    const list = await user.get<any[]>('/api/stories');
    assert.equal(list.find((s) => s.id === 's_legacy1').shotCount, 2);
  });

  test('STY-04 迁移失败的故事保持旧格式、只读打开，不影响服务', async () => {
    // 场次 id 和另一个已迁移故事的重复：写表后读回对不上，整体回滚
    await insertLegacy(user, { ...legacyData(), chapters: [{ ...legacyData().chapters[0], id: 'ch_1' }] }, 's_legacy_bad');
    const story = await user.get('/api/stories/s_legacy_bad');
    assert.equal(story.readOnly, true);
    assert.equal(story.data.chapters[0].scenes[0].title, '雨夜街头');
    const write = await user.raw('POST', '/api/stories/s_legacy_bad/ops', { ops: [{ op: 'set', entity: 'story', id: 'story', patch: { title: 'x' } }] });
    assert.equal(write.status, 409);
    // 原故事完好
    const ok = await user.get('/api/stories/s_legacy1');
    assert.equal(ok.data.chapters[0].title, '第一章');
  });

  test('STY-05 增量保存：字段级修改、新建、移动、删除；指向已删除实体的操作被忽略；rev 递增', async () => {
    const created = await user.post('/api/stories', { title: '增量', logline: '' });
    let result = await edit(user, created.id, (d) => {
      d.data.characters.push({ id: 'c_x', name: '甲', role: '', appearance: '', personality: '', referenceAssetId: null });
      d.data.chapters.push({ id: 'ch_x', title: '一', summary: '', scenes: [{ id: 'sc_x', title: '场', location: '', time: '', summary: '', dialogue: [], shots: [] }] });
      d.data.chapters[0].scenes[0].shots.push(
        { id: 'sh_a', shotSize: '中景', cameraMove: '固定', description: 'A', dialogueIds: [], duration: 5, characterIds: ['c_x'], keyframeAssetId: null, videoAssetId: null },
        { id: 'sh_b', shotSize: '中景', cameraMove: '固定', description: 'B', dialogueIds: [], duration: 3, characterIds: [], keyframeAssetId: null, videoAssetId: null },
      );
    });
    assert.equal(result.rev, created.rev + 1);
    result = await edit(user, created.id, (d) => {
      d.data.chapters[0].scenes[0].shots.reverse();
      d.data.chapters[0].scenes[0].shots[0].locked = true;
      d.data.chapters[0].scenes[0].shots[1].characterIds = [];
      d.data.visualStyle = '水墨';
    });
    let story = await user.get(`/api/stories/${created.id}`);
    assert.deepEqual(story.data.chapters[0].scenes[0].shots.map((s: any) => s.id), ['sh_b', 'sh_a']);
    assert.equal(story.data.chapters[0].scenes[0].shots[0].locked, true);
    assert.deepEqual(story.data.chapters[0].scenes[0].shots[1].characterIds, []);
    assert.equal(story.data.visualStyle, '水墨');
    const stats = (await user.get<any[]>('/api/stories')).find((s) => s.id === created.id).stats;
    assert.equal(stats.shots, 2);
    assert.equal(stats.duration, 8);

    // 另一个设备删了场次，这边还在改场次里的镜头：改动被忽略，不报错
    await user.post(`/api/stories/${created.id}/ops`, { ops: [{ op: 'delete', entity: 'scene', id: 'sc_x' }] });
    const late = await user.post(`/api/stories/${created.id}/ops`, {
      ops: [
        { op: 'set', entity: 'shot', id: 'sh_a', patch: { description: '迟到的修改' } },
        { op: 'create', entity: 'shot', id: 'sh_c', parentId: 'sc_x', sortKey: 'i', value: {} },
      ],
    });
    assert.equal(late.ignored.length, 2);
    story = await user.get(`/api/stories/${created.id}`);
    assert.equal(story.data.chapters[0].scenes.length, 0);

    // 不能通过 ops 改别人的故事
    const other = await h.user();
    const theirs = await other.post('/api/stories', { title: '别人的', logline: '' });
    await edit(other, theirs.id, (d) => d.data.chapters.push({ id: 'ch_theirs', title: '他们的', summary: '', scenes: [] }));
    const hijack = await user.post(`/api/stories/${created.id}/ops`, { ops: [{ op: 'set', entity: 'chapter', id: 'ch_theirs', patch: { title: '被改了' } }] });
    assert.equal(hijack.ignored.length, 1);
    assert.equal((await other.get(`/api/stories/${theirs.id}`)).data.chapters[0].title, '他们的');
    assert.equal((await user.raw('POST', `/api/stories/${theirs.id}/ops`, { ops: [] })).status, 404);
  });

  test('STY-05 其他设备同步：按 rev 拉取修改；旧版前端的整篇保存返回 409', async () => {
    const created = await user.post('/api/stories', { title: '同步', logline: '' });
    await edit(user, created.id, (d) => (d.title = '设备 A 改的标题'), 'device-a');
    await edit(user, created.id, (d) => d.data.chapters.push({ id: 'ch_sync', title: '新章', summary: '', scenes: [] }), 'device-a');
    const changes = await user.get(`/api/stories/${created.id}/changes?since=${created.rev}`);
    assert.equal(changes.changes.length, 2);
    assert.equal(changes.changes[0].clientId, 'device-a');
    // 设备 B 用拉到的修改更新自己的内存模型
    const keys: SortKeys = new Map(Object.entries(created.keys ?? {}));
    let state = { title: created.title, data: created.data as StoryData };
    for (const change of changes.changes) state = applyStoryOps(state, change.ops, keys);
    const server = await user.get(`/api/stories/${created.id}`);
    assert.equal(state.title, server.title);
    assert.deepEqual(state.data.chapters.map((c) => c.id), server.data.chapters.map((c: any) => c.id));

    const put = await user.raw('PUT', `/api/stories/${created.id}`, { title: 'x', data: {}, baseRev: 1 });
    assert.equal(put.status, 409);
    assert.match((await put.json()).error, /织影已升级/);
  });

  test('STY-06 历史版本：手动保存永久保留；恢复前自动存一份；可只读预览', async () => {
    const created = await user.post('/api/stories', { title: '版本', logline: '' });
    await edit(user, created.id, (d) => d.data.chapters.push({ id: 'ch_v1', title: '原来的章', summary: '', scenes: [] }));
    const manual = await user.post(`/api/stories/${created.id}/snapshots`, { label: '定稿前' });
    assert.equal(manual.pinned, true);
    assert.equal(manual.stats.chapters, 1);
    await edit(user, created.id, (d) => (d.data.chapters[0].title = '改坏了'));
    const restored = await user.post(`/api/stories/${created.id}/snapshots/${manual.id}/restore`);
    assert.equal(restored.data.chapters[0].title, '原来的章');
    const list = await user.get<any[]>(`/api/stories/${created.id}/snapshots`);
    assert.ok(list.some((s) => s.reason === 'before_restore'));
    const preview = await user.get(`/api/stories/${created.id}/snapshots/${list.find((s) => s.reason === 'before_restore').id}`);
    assert.equal(preview.data.chapters[0].title, '改坏了');
  });

  test('STY-04 千镜头级：3000 个镜头一次提交，整篇载入在 1.5 秒内', async () => {
    const created = await user.post('/api/stories', { title: '长篇', logline: '' });
    const big = structuredClone({ title: created.title, data: created.data as StoryData });
    for (let c = 0; c < 10; c++) {
      big.data.chapters.push({ id: `ch_big${c}`, title: `第 ${c + 1} 章`, summary: '', scenes: [] });
      for (let sc = 0; sc < 10; sc++) {
        const shots = Array.from({ length: 30 }, (_, i) => ({
          id: `sh_big${c}_${sc}_${i}`,
          shotSize: '中景',
          cameraMove: '固定',
          description: `第 ${c + 1} 章第 ${sc + 1} 场第 ${i + 1} 镜：雨夜街头，人物缓缓回头，霓虹倒映在积水里`,
          dialogueIds: [],
          duration: 4,
          characterIds: [],
          keyframeAssetId: null,
          videoAssetId: null,
        }));
        big.data.chapters[c].scenes.push({ id: `sc_big${c}_${sc}`, title: `场 ${sc + 1}`, location: '', time: '', summary: '', dialogue: [], shots });
      }
    }
    const ops = diffStory({ title: created.title, data: created.data }, big, new Map(Object.entries(created.keys ?? {})));
    assert.equal(ops.length, 3110);
    await user.post(`/api/stories/${created.id}/ops`, { ops });
    const started = Date.now();
    const story = await user.get(`/api/stories/${created.id}`);
    const ms = Date.now() - started;
    assert.equal(story.data.chapters.reduce((n: number, c: any) => n + c.scenes.reduce((m: number, s: any) => m + s.shots.length, 0), 0), 3000);
    assert.ok(ms < 1500, `载入耗时 ${ms} ms`);
  });

  test('STY-06 保留策略（模拟时钟）：7 天内全留、90 天内每天 1 份、更早每周 1 份、手动保存永久保留', () => {
    const day = 86_400_000;
    const at = 400 * day;
    const rows: { id: string; createdAt: number; pinned: boolean }[] = [];
    // 每 6 小时一份，持续 200 天
    for (let i = 0; i < 200 * 4; i++) rows.push({ id: `s${i}`, createdAt: at - i * 6 * 3600_000, pinned: false });
    rows.push({ id: 'manual-old', createdAt: at - 300 * day, pinned: true });
    const remove = new Set(snapshotsToPrune(rows, at));
    const kept = rows.filter((row) => !remove.has(row.id));
    const recent = kept.filter((row) => at - row.createdAt < 7 * day);
    assert.equal(recent.length, 28, '7 天内全部保留');
    const daily = kept.filter((row) => at - row.createdAt >= 7 * day && at - row.createdAt < 90 * day);
    assert.ok(daily.length >= 83 && daily.length <= 84, `90 天内每天 1 份：${daily.length}`);
    const weekly = kept.filter((row) => at - row.createdAt >= 90 * day && !row.pinned);
    assert.ok(weekly.length >= 15 && weekly.length <= 17, `更早每周 1 份：${weekly.length}`);
    assert.ok(kept.some((row) => row.id === 'manual-old'));
  });
});
