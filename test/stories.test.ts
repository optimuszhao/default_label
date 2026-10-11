// M0a · STY-01（保存冲突与历史版本）、AST-01（资产分页）
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { IMAGE_PARAMS, startHarness, until, type Client, type Harness } from './harness.ts';

let h: Harness;
let user: Client;

before(async () => {
  h = await startHarness({ PROVIDER: 'mock' });
  user = await h.user();
});
after(async () => h?.stop());

describe('故事保存', () => {
  const setTitle = (id: string, title: string) => user.post(`/api/stories/${id}/ops`, { ops: [{ op: 'set', entity: 'story', id: 'story', patch: { title } }] });

  test('增量保存：版本号递增；旧版前端的整篇保存提示刷新', async () => {
    const story = await user.post('/api/stories', { title: '冲突测试', logline: '一句话' });
    const saved = await setTitle(story.id, '第一版');
    assert.equal(saved.rev, story.rev + 1);
    assert.equal((await user.get(`/api/stories/${story.id}`)).title, '第一版');
    const stale = await user.raw('PUT', `/api/stories/${story.id}`, { title: '旧标签页', data: story.data, baseRev: 0 });
    assert.equal(stale.status, 409);
  });

  test('每天第一次保存留一份历史版本，可以恢复，恢复前再存一份', async () => {
    const story = await user.post('/api/stories', { title: '原始标题', logline: '' });
    await setTitle(story.id, '改过的标题');
    await setTitle(story.id, '再改一次');
    const snapshots = await user.get<any[]>(`/api/stories/${story.id}/snapshots`);
    assert.equal(snapshots.length, 1, '同一天只留一份');
    assert.equal(snapshots[0].reason, 'daily');
    assert.equal(snapshots[0].title, '原始标题');

    const restored = await user.post(`/api/stories/${story.id}/snapshots/${snapshots[0].id}/restore`);
    assert.equal(restored.title, '原始标题');
    const after = await user.get<any[]>(`/api/stories/${story.id}/snapshots`);
    assert.equal(after[0].reason, 'before_restore');
    assert.equal(after[0].title, '再改一次');
  });

  test('AI 改写前自动留历史版本', async () => {
    const story = await user.post('/api/stories', { title: 'AI 前', logline: '少女与机器人' });
    const result = await user.post('/api/assist/outline', { storyId: story.id, title: 'AI 前', logline: '少女与机器人' });
    assert.ok(result.outline);
    const snapshots = await user.get<any[]>(`/api/stories/${story.id}/snapshots`);
    assert.equal(snapshots[0].reason, 'ai:outline');
  });

  test('不能读写别人的故事和历史版本', async () => {
    const story = await user.post('/api/stories', { title: '私有', logline: '' });
    const other = await h.user();
    assert.equal((await other.raw('GET', `/api/stories/${story.id}/snapshots`)).status, 404);
    assert.equal((await other.raw('POST', `/api/stories/${story.id}/ops`, { ops: [] })).status, 404);
  });
});

describe('资产分页', () => {
  test('同一毫秒写入的多条资产，分页不重复也不遗漏', async () => {
    const pager = await h.user();
    const task = await pager.post('/api/tasks', { type: 't2i', prompt: '分页', params: { ...IMAGE_PARAMS, count: 4 } });
    const done = await until(async () => {
      const t = (await pager.get<any[]>('/api/tasks')).find((x) => x.id === task.id);
      return t?.status === 'succeeded' ? t : null;
    }, 30_000, '生成完成');
    assert.equal(done.outputAssetIds.length, 4);
    // 把 4 条资产的时间改成同一毫秒
    const db = new DatabaseSync(path.join(h.dataDir, 'weave.db'));
    const ids = done.outputAssetIds as string[];
    db.prepare(`UPDATE assets SET created_at = 1700000000000 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    db.close();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const list = await pager.get<any[]>(`/api/assets?limit=3${cursor ? `&before=${cursor}` : ''}`);
      seen.push(...list.map((a) => a.id));
      if (list.length < 3) break;
      const last = list[list.length - 1];
      cursor = `${last.createdAt}:${last.id}`;
    }
    assert.equal(seen.length, 4);
    assert.deepEqual([...seen].sort(), [...ids].sort());
  });
});
