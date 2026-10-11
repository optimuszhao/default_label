// M7c 故事效率与导出：模板、故事列表 v2（状态、回收站、复制）、文本导出、关键帧 ZIP（AI 标识）、图文排版、资产按镜头和设定检索
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { diffStory, type SortKeys } from '../shared/story-ops.ts';
import type { StoryData } from '../shared/types.ts';
import { type Client, type Harness, startHarness, until } from './harness.ts';

let h: Harness;
let user: Client;
let seq = 0;

before(async () => {
  h = await startHarness();
  user = await h.user();
});
after(async () => h?.stop());

function sample(): StoryData {
  const t = `x${++seq}`;
  return {
    logline: '雨夜寻人',
    genre: '',
    tone: '',
    visualStyle: '电影感',
    aspectRatio: '16:9',
    outline: '',
    characters: [{ id: `c_${t}`, name: '林昔', role: '主角', appearance: '短发', personality: '', referenceAssetId: null }],
    elements: [{ id: `e_${t}`, kind: 'prop', name: '旧收音机', snippet: '木壳' }],
    chapters: [
      {
        id: `ch_${t}`,
        title: '开端',
        summary: '',
        scenes: [
          {
            id: `sc_${t}`,
            title: '雨夜街头',
            location: '旧城区',
            time: '夜',
            summary: '林昔撑伞寻找哥哥。',
            dialogue: [
              { id: `d1_${t}`, characterId: `c_${t}`, text: '哥哥，你在哪？', emotion: '焦急' },
              { id: `d2_${t}`, characterId: null, text: '雨越下越大。', emotion: '' },
            ],
            shots: [
              { id: `s1_${t}`, shotSize: '远景', cameraMove: '推', description: '雨夜街头全景', dialogueIds: [`d2_${t}`], duration: 4, characterIds: [], elementIds: [`e_${t}`], keyframeAssetId: null, videoAssetId: null, code: 'A-01' },
              { id: `s2_${t}`, shotSize: '近景', cameraMove: '固定', description: '林昔回头', dialogueIds: [`d1_${t}`], duration: 6, characterIds: [`c_${t}`], keyframeAssetId: null, videoAssetId: null },
            ],
          },
        ],
      },
    ],
  };
}

async function newStory(data: StoryData, title = '导出测试'): Promise<{ id: string; data: StoryData }> {
  const created = await user.post('/api/stories', { title, logline: '' });
  const keys: SortKeys = new Map(Object.entries(created.keys ?? {}));
  await user.post(`/api/stories/${created.id}/ops`, { ops: diffStory({ title: created.title, data: created.data }, { title, data }, keys) });
  return { id: created.id, data };
}

describe('M7c 故事效率与导出', () => {
  test('STY-12 6 个故事模板都能创建故事；绘本模板只出图、带骨架', async () => {
    const templates = await user.get<any[]>('/api/story-templates');
    assert.equal(templates.length, 6);
    for (const template of templates) {
      const story = await user.post('/api/stories', { title: template.name, logline: '', templateId: template.id });
      assert.equal(story.templateId, template.id);
      assert.ok(story.data.chapters.length > 0, `${template.name} 有章节骨架`);
      if (template.settings.aspectRatio) assert.equal(story.data.aspectRatio, template.settings.aspectRatio);
    }
    const book = templates.find((t) => t.id === 'picture-book');
    assert.equal(book.imageOnly, true);
    assert.equal((await user.raw('POST', '/api/stories', { title: 'x', templateId: 'nope' })).status, 400);
  });

  test('STY-13 故事列表 v2：进行中 / 已完成 / 已归档 / 回收站；复制故事换新 id', async () => {
    const { id } = await newStory(sample(), '列表');
    await user.patch(`/api/stories/${id}`, { status: 'archived', lastPosition: { tab: 'shots', sceneId: null } });
    assert.ok((await user.get<any[]>('/api/stories?status=archived')).some((s) => s.id === id));
    assert.ok(!(await user.get<any[]>('/api/stories?status=active')).some((s) => s.id === id));
    const listed = (await user.get<any[]>('/api/stories')).find((s) => s.id === id);
    assert.equal(listed.lastPosition.tab, 'shots');
    const copy = await user.post(`/api/stories/${id}/duplicate`);
    assert.equal(copy.title, '列表 副本');
    assert.equal(copy.data.chapters[0].scenes[0].shots.length, 2);
    assert.notEqual(copy.data.chapters[0].scenes[0].shots[0].id, sample().chapters[0].scenes[0].shots[0].id);
    const original = await user.get(`/api/stories/${id}`);
    const shot2 = copy.data.chapters[0].scenes[0].shots[1];
    assert.deepEqual(shot2.characterIds, [copy.data.characters[0].id], '出镜角色指向复制出来的新角色');
    assert.notEqual(copy.data.characters[0].id, original.data.characters[0].id);
    await user.raw('DELETE', `/api/stories/${id}`);
    assert.ok((await user.get<any[]>('/api/stories?status=trash')).some((s) => s.id === id));
    await user.post(`/api/stories/${id}/restore`);
    assert.ok((await user.get<any[]>('/api/stories')).some((s) => s.id === id));
  });

  test('EXP-01 剧本 Markdown：场号、内外景、台词结构；字幕 SRT 能被 ffprobe 识别；镜头表 CSV；都带 AI 标识', async () => {
    const { id } = await newStory(sample(), '导出');
    const md = await (await user.raw('GET', `/api/stories/${id}/export/script.md`)).text();
    assert.match(md, /^# 导出/);
    assert.match(md, /本内容由 AI 辅助生成/);
    assert.match(md, /### 1-1 · 旧城区 · 外景 · 夜　雨夜街头/);
    assert.match(md, /\*\*林昔\*\*（焦急）：哥哥，你在哪？/);
    assert.match(md, /\*（旁白）雨越下越大。\*/);
    const txt = await (await user.raw('GET', `/api/stories/${id}/export/script.txt`)).text();
    assert.ok(!txt.includes('**'));

    const srtResponse = await user.raw('GET', `/api/stories/${id}/export/subtitles.srt`);
    assert.match(srtResponse.headers.get('content-disposition') ?? '', /UTF-8''/);
    const srt = await srtResponse.text();
    assert.match(srt, /00:00:00,000 --> 00:00:02,000\n本内容由 AI 辅助生成/);
    assert.match(srt, /00:00:00,000 --> 00:00:03,950\n雨越下越大。/);
    assert.match(srt, /00:00:04,000 --> 00:00:09,950\n林昔：哥哥，你在哪？/);
    if (spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0) {
      const file = path.join(os.tmpdir(), `weave-${process.pid}.srt`);
      fs.writeFileSync(file, srt);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { encoding: 'utf8' });
      fs.rmSync(file, { force: true });
      assert.equal(probe.stdout.trim(), 'subrip');
    }
    const ass = await (await user.raw('GET', `/api/stories/${id}/export/subtitles.ass`)).text();
    assert.match(ass, /\[Events\]/);
    assert.match(ass, /Dialogue: 0,0:00:04.00,0:00:09.95,Default,,0,0,0,,林昔：哥哥，你在哪？/);

    const csvBytes = Buffer.from(await (await user.raw('GET', `/api/stories/${id}/export/shots.csv`)).arrayBuffer());
    assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], '带 UTF-8 BOM');
    const csv = csvBytes.toString('utf8').replace(/^\ufeff/, '');
    assert.ok(csv.startsWith('序号,镜头编号,章,场'));
    const rows = csv.trim().split('\r\n');
    assert.equal(rows.length, 4, '表头 + 2 镜 + AI 标识');
    assert.match(rows[1], /^1,A-01,开端,雨夜街头,远景,推,4,雨夜街头全景,旧收音机/);
  });

  test('EXP-01 关键帧 ZIP：按全片顺序命名，PNG 里写入 AIGC 标识，附说明和 manifest', async () => {
    const { id, data } = await newStory(sample(), '关键帧');
    await user.post(`/api/stories/${id}/generate`, { scope: { type: 'all' }, content: 'keyframe', mode: 'missing' });
    await until(async () => (await user.get<any[]>(`/api/tasks?storyId=${id}`)).filter((t) => t.status === 'succeeded').length === 2, 30_000, '两张关键帧');
    const response = await user.raw('GET', `/api/stories/${id}/export/keyframes.zip`);
    assert.equal(response.status, 200);
    const zip = Buffer.from(await response.arrayBuffer());
    assert.ok(zip.includes(Buffer.from('001-1-1-')));
    assert.ok(zip.includes(Buffer.from('AI标识说明.txt')));
    assert.ok(zip.includes(Buffer.from('manifest.json')));
    assert.ok(zip.includes(Buffer.from('tEXtAIGC')), 'PNG 里有 AIGC 文本块');
    void data;
  });

  test('STY-18 资产能按镜头编号、出镜设定名检索；EXP-07 图文版式保存和读回', async () => {
    const { id } = await newStory(sample(), '检索');
    await user.post(`/api/stories/${id}/generate`, { scope: { type: 'all' }, content: 'keyframe', mode: 'missing' });
    await until(async () => (await user.get<any[]>(`/api/tasks?storyId=${id}`)).filter((t) => t.status === 'succeeded').length === 2, 30_000, '关键帧');
    const byElement = await user.get<any[]>(`/api/assets?storyId=${id}&q=${encodeURIComponent('旧收音机')}`);
    assert.equal(byElement.length, 1, '第 1 镜出镜了旧收音机');
    const byCode = await user.get<any[]>(`/api/assets?storyId=${id}&q=${encodeURIComponent('A-01')}`);
    assert.equal(byCode.length, 1);

    const pages = [{ panels: [{ shotId: 'x', text: '从前……', bubbles: [] }] }];
    await user.put(`/api/stories/${id}/layouts/picture_book`, { title: '绘本', pages });
    const layouts = await user.get<any[]>(`/api/stories/${id}/layouts`);
    assert.equal(layouts[0].kind, 'picture_book');
    assert.deepEqual(layouts[0].pages, pages);
    assert.equal((await user.raw('PUT', `/api/stories/${id}/layouts/poster`, { pages: [] })).status, 400);
  });
});
