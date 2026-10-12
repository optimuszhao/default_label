// STY-11 镜头表 CSV 导入：按"章""场"两列分到对应场次（之前全部落到当前场次）、新建缺的章和场次、改了"场"的已有镜头挪过去
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { StoryData } from '../shared/types.ts';
import { applyCsv } from '../web/src/pages/studio/story/shotCsv.ts';

const HEADER = '序号,镜头编号,章,场,景别,运镜,时长,画面描述,出镜,台词,定稿,id';

function story(): StoryData {
  const shot = (id: string, description: string) => ({ id, shotSize: '中景', cameraMove: '固定', description, dialogueIds: [], duration: 5, characterIds: [], keyframeAssetId: null, videoAssetId: null });
  return {
    logline: '', genre: '', tone: '', visualStyle: '', aspectRatio: '16:9', outline: '', characters: [],
    chapters: [
      {
        id: 'ch1', title: '第一章', summary: '',
        scenes: [
          { id: 'sc1', title: '雨夜街头', location: '', time: '', summary: '', dialogue: [], shots: [shot('sh1', '撑伞走过')] },
          { id: 'sc2', title: '旧书店', location: '', time: '', summary: '', dialogue: [], shots: [shot('sh2', '推门进店')] },
        ],
      },
    ],
  };
}

const titles = (data: StoryData) => data.chapters.map((c) => `${c.title}:${c.scenes.map((s) => `${s.title}(${s.shots.map((x) => x.description).join('|')})`).join(',')}`);

describe('STY-11 镜头表 CSV 导入', () => {
  test('手写的新镜头按"场"列分到各自场次，不再全部堆进第一个场次', () => {
    const csv = [
      HEADER,
      '1,,第一章,雨夜街头,远景,推,4,霓虹倒映在水洼,,,,',
      '2,,第一章,旧书店,特写,固定,3,积灰的书脊,,,,',
      '3,,第一章,天台,全景,环绕,6,城市夜景,,,,',
      '4,,第二章,清晨,中景,跟,5,她走出家门,,,,',
      '# 本内容由 AI 辅助生成',
    ].join('\r\n');
    const result = applyCsv(story(), csv, 'sc1');
    assert.equal(result.added, 4);
    assert.equal(result.created, 2, '天台、清晨两个场次是新建的');
    assert.deepEqual(titles(result.data), [
      '第一章:雨夜街头(撑伞走过|霓虹倒映在水洼),旧书店(推门进店|积灰的书脊),天台(城市夜景)',
      '第二章:清晨(她走出家门)',
    ]);
    const added = result.data.chapters[0].scenes[1].shots[1];
    assert.equal(added.shotSize, '特写');
    assert.equal(added.duration, 3);
  });

  test('导出再导回：按 id 更新；"场"改成别的场次时镜头挪过去', () => {
    const csv = [HEADER, '1,,第一章,旧书店,近景,摇,2,撑伞走过（改）,,,,sh1', '2,,第一章,旧书店,中景,固定,5,推门进店,,,,sh2'].join('\n');
    const result = applyCsv(story(), csv, 'sc1');
    assert.equal(result.updated, 2);
    assert.equal(result.added, 0);
    assert.deepEqual(titles(result.data), ['第一章:雨夜街头(),旧书店(推门进店|撑伞走过（改）)']);
  });

  test('没有"章""场"列的表格追加到当前场次；章名为空时按场名在全片里找', () => {
    const plain = applyCsv(story(), ['景别,时长,画面描述', '远景,4,远处的钟楼'].join('\n'), 'sc2');
    assert.deepEqual(titles(plain.data), ['第一章:雨夜街头(撑伞走过),旧书店(推门进店|远处的钟楼)']);
    const sceneOnly = applyCsv(story(), ['场,画面描述', '雨夜街头,路灯闪烁'].join('\n'), 'sc2');
    assert.deepEqual(titles(sceneOnly.data), ['第一章:雨夜街头(撑伞走过|路灯闪烁),旧书店(推门进店)']);
  });
});
