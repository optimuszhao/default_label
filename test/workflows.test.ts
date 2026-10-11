// M8a 工作流：定义校验、W1 四选一（重启后挑选继续）、无人值守、取消级联、上限、W2 写回角色、W4 接力 + 拼接、W5 LLM 拆镜头、后台启停
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { validateWorkflow, w4 } from '../server/workflows/defs.ts';
import { Client, type Harness, IMAGE_PARAMS, startHarness, until } from './harness.ts';

const ADMIN = 'admin@workflow.test';
const FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

let h: Harness;
let admin: Client;

before(async () => {
  h = await startHarness({ ADMIN_EMAILS: ADMIN, LLM_MOCK: '1' });
  admin = await h.user(ADMIN);
});
after(async () => h?.stop());

async function waitRun(client: Client, id: string, statuses: string[], timeout = 40_000): Promise<any> {
  return until(async () => {
    const run = await client.get(`/api/workflow-runs/${id}`);
    return statuses.includes(run.status) ? run : null;
  }, timeout, `运行进入 ${statuses.join('/')}`);
}

async function anImage(client: Client): Promise<string> {
  const task = await client.post('/api/tasks', { type: 't2i', prompt: '起始画面', params: IMAGE_PARAMS });
  const done = await until(async () => (await client.get<any[]>('/api/tasks')).find((t) => t.id === task.id && t.status === 'succeeded'), 30_000, '起始画面');
  return done.outputAssetIds[0];
}

describe('M8a 工作流', () => {
  test('WF-05 官方工作流定义都通过校验；接力用在并行步骤上会被发现', () => {
    assert.deepEqual(validateWorkflow(w4), []);
    const broken = { ...w4, id: 'broken', steps: [{ ...w4.steps[0], forEach: { over: () => ['a', 'b'], mode: 'parallel' as const } }, w4.steps[1]] };
    assert.ok(validateWorkflow(broken).some((e) => e.includes('接力只能用在串行的图生视频上')));
    const dup = { ...w4, id: 'dup', steps: [w4.steps[0], w4.steps[0]] };
    assert.ok(validateWorkflow(dup).some((e) => e.includes('重复')));
  });

  test('WF-01 W1 四选一：4 张候选 → 等你挑 → 服务重启后状态保留 → 挑选后继续出视频', async () => {
    const list = await admin.get<any[]>('/api/workflows');
    assert.ok(list.some((w) => w.id === 'w1-pick-to-video'));
    const run = await admin.post('/api/workflows/w1-pick-to-video/runs', { inputs: { idea: '雨夜霓虹街头，撑伞的少女回眸' } });
    assert.equal(run.status, 'running');
    let waiting = await waitRun(admin, run.id, ['waiting']);
    const kf = waiting.steps.find((s: any) => s.id === 'kf');
    assert.equal(kf.assets.length, 4);
    assert.equal(waiting.steps.find((s: any) => s.id === 'pick').status, 'waiting');
    // 4 个任务的种子各不相同、提示词带上了风格预设
    const tasks = await admin.get<any[]>('/api/tasks?limit=50');
    const kfTasks = tasks.filter((t) => kf.taskIds.includes(t.id));
    assert.equal(kfTasks.length, 4);
    assert.ok(kfTasks.every((t) => t.prompt.includes('雨夜霓虹街头')));

    // 重启服务：运行状态保留
    await h.stop({ keepData: true });
    const dataDir = h.dataDir;
    h = await startHarness({ ADMIN_EMAILS: ADMIN, LLM_MOCK: '1', DATA_DIR: dataDir });
    const again = new Client(h.base);
    again.cookie = admin.cookie;
    admin = again;
    // 算子地址存在数据库里，换成新的假算子
    await admin.patch('/api/admin/operators/op_default', { baseUrl: h.operator });
    waiting = await admin.get(`/api/workflow-runs/${run.id}`);
    assert.equal(waiting.status, 'waiting');

    // 只能从候选里挑，数量要对
    assert.equal((await admin.raw('POST', `/api/workflow-runs/${run.id}/steps/pick/select`, { assetIds: ['a_not_mine'] })).status, 400);
    assert.equal((await admin.raw('POST', `/api/workflow-runs/${run.id}/steps/pick/select`, { assetIds: kf.assets.slice(0, 2) })).status, 400);
    await admin.post(`/api/workflow-runs/${run.id}/steps/pick/select`, { assetIds: [kf.assets[2]] });
    const done = await waitRun(admin, run.id, ['succeeded', 'failed']);
    assert.equal(done.status, 'succeeded', done.error ?? '');
    const vid = done.steps.find((s: any) => s.id === 'vid');
    const videoTask = (await admin.get<any[]>('/api/tasks?limit=50')).find((t) => t.id === vid.taskIds[0]);
    assert.equal(videoTask.type, 'i2v');
    assert.equal(videoTask.inputs.firstFrameAssetId, kf.assets[2]);
    assert.ok(done.outputs.includes(vid.assets[0]));
  });

  test('WF-01 无人值守自动选第一张；取消运行时名下排队的任务一起取消', async () => {
    const auto = await admin.post('/api/workflows/w1-pick-to-video/runs', { inputs: { idea: '海边灯塔' }, unattended: true });
    const done = await waitRun(admin, auto.id, ['succeeded', 'failed']);
    assert.equal(done.status, 'succeeded', done.error ?? '');
    assert.match(done.steps.find((s: any) => s.id === 'pick').note, /自动选了第一张/);

    const idle = await h.user(undefined, { autoDispatch: false });
    const run = await idle.post('/api/workflows/w1-pick-to-video/runs', { inputs: { idea: '不会跑完的' } });
    const taskIds = run.steps.find((s: any) => s.id === 'kf').taskIds as string[];
    assert.equal(taskIds.length, 4);
    await idle.post(`/api/workflow-runs/${run.id}/cancel`);
    const tasks = await idle.get<any[]>('/api/tasks');
    assert.ok(taskIds.every((id) => tasks.find((t) => t.id === id)?.status === 'canceled'));
    assert.equal((await idle.get(`/api/workflow-runs/${run.id}`)).status, 'canceled');
  });

  test('WF-01 上限：每人最多 3 个进行中的运行；暂停和继续', async () => {
    const idle = await h.user(undefined, { autoDispatch: false });
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await idle.post('/api/workflows/w1-pick-to-video/runs', { inputs: { idea: `第 ${i} 个` } }));
    const fourth = await idle.raw('POST', '/api/workflows/w1-pick-to-video/runs', { inputs: { idea: '第 4 个' } });
    assert.equal(fourth.status, 429);
    // 暂停后即使候选都生成好了，也不会进入"等你挑选"，继续后才推进
    const paused = await idle.post(`/api/workflow-runs/${runs[0].id}/pause`);
    assert.equal(paused.status, 'paused');
    const kfIds = paused.steps[0].taskIds as string[];
    await until(async () => (await idle.get<any[]>('/api/tasks')).filter((t) => kfIds.includes(t.id)).every((t) => ['succeeded', 'paused'].includes(t.status)), 30_000, '候选结束或暂停');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await idle.get(`/api/workflow-runs/${runs[0].id}`)).status, 'paused');
    await idle.post(`/api/workflow-runs/${runs[0].id}/resume`);
    await waitRun(idle, runs[0].id, ['waiting']);
    for (const run of runs) await idle.post(`/api/workflow-runs/${run.id}/cancel`);
  });

  test('WF-02 W2 角色定妆照：挑中的图写回故事角色的主参考图，4 张都挂到角色下当候选', async () => {
    const story = await admin.post('/api/stories', { title: '定妆', logline: '' });
    await admin.post(`/api/stories/${story.id}/ops`, { ops: [{ op: 'create', entity: 'character', id: 'c_wf2', sortKey: 'i', value: { name: '林昔', appearance: '短发少女' } }] });
    const characters = await admin.get<any[]>('/api/workflows/characters');
    const option = characters.find((c) => c.value === `${story.id}:c_wf2`);
    assert.equal(option.appearance, '短发少女');
    const run = await admin.post('/api/workflows/w2-character-portrait/runs', { inputs: { character: option.value, name: '林昔', appearance: '短发少女' }, unattended: true });
    const done = await waitRun(admin, run.id, ['succeeded', 'failed']);
    assert.equal(done.status, 'succeeded', done.error ?? '');
    const picked = done.steps.find((s: any) => s.id === 'pick').assets[0];
    const after = await admin.get(`/api/stories/${story.id}`);
    assert.equal(after.data.characters[0].referenceAssetId, picked);
    const media = await admin.get<any[]>(`/api/stories/${story.id}/media`);
    assert.equal(media.filter((a) => a.shotId === 'char_c_wf2').length, 4);
  });

  test('WF-02 W4 长镜头接力：逐段用上一段尾帧做首帧，最后拼接成片', { skip: !FFMPEG && '没有 ffmpeg' }, async () => {
    await h.scenario({ realMedia: true });
    const start = await anImage(admin);
    const run = await admin.post('/api/workflows/w4-relay/runs', { inputs: { start, beats: '推门进花园\n拾起信封', duration: 5 } });
    const done = await waitRun(admin, run.id, ['succeeded', 'failed'], 60_000);
    assert.equal(done.status, 'succeeded', done.error ?? '');
    const seg = done.steps.find((s: any) => s.id === 'seg');
    assert.equal(seg.assets.length, 2);
    const tasks = await admin.get<any[]>('/api/tasks?limit=100');
    const second = tasks.find((t) => t.id === seg.taskIds[1]);
    const frame = await admin.get(`/api/assets/${second.inputs.firstFrameAssetId}`);
    assert.equal(frame.lineage, 'frame');
    assert.equal(frame.parentAssetId, seg.assets[0], '第 2 段的首帧截自第 1 段');
    const join = done.steps.find((s: any) => s.id === 'join');
    const film = await admin.get(`/api/assets/${join.assets[0]}`);
    assert.equal(film.kind, 'video');
    assert.ok(film.duration >= 2, `成片时长 ${film.duration}`);
    await h.scenario({ realMedia: false });
  });

  test('WF-03 W5 一句话短片：LLM 拆镜头 → 出画面 → 动起来 → 拼接', { skip: !FFMPEG && '没有 ffmpeg' }, async () => {
    await h.scenario({ realMedia: true });
    const run = await admin.post('/api/workflows/w5-one-line-film/runs', { inputs: { idea: '橘猫在屋顶等主人', count: 2 } });
    const done = await waitRun(admin, run.id, ['succeeded', 'failed'], 60_000);
    assert.equal(done.status, 'succeeded', done.error ?? '');
    assert.equal(done.steps.find((s: any) => s.id === 'frames').assets.length, 2);
    assert.equal(done.steps.find((s: any) => s.id === 'clips').assets.length, 2);
    assert.equal(done.steps.find((s: any) => s.id === 'join').assets.length, 1);
    await h.scenario({ realMedia: false });
  });

  test('WF-06 后台停用工作流：列表里不再出现，也不能启动；改默认参数', async () => {
    const before = await admin.get<any[]>('/api/admin/workflows');
    assert.equal(before.length, 4);
    await admin.patch('/api/admin/workflows/w2-character-portrait', { enabled: false });
    assert.ok(!(await admin.get<any[]>('/api/workflows')).some((w) => w.id === 'w2-character-portrait'));
    assert.equal((await admin.raw('POST', '/api/workflows/w2-character-portrait/runs', { inputs: {} })).status, 400);
    await admin.patch('/api/admin/workflows/w1-pick-to-video', { defaults: { style: 'style-ink', bogus: 1 } });
    const w1 = (await admin.get<any[]>('/api/workflows')).find((w) => w.id === 'w1-pick-to-video');
    assert.equal(w1.inputs.find((i: any) => i.key === 'style').default, 'style-ink');
    const user = await h.user();
    assert.equal((await user.raw('GET', '/api/admin/workflows')).status, 404);
  });
});
