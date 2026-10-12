// STY-11 导入镜头表 CSV：按"章""场"列分进各自场次（含新建场次），自动保存到服务端
import { expect, test } from '@playwright/test';

test('STY-11 导入 CSV：镜头按场次分开，新场次自动建好并保存', async ({ page, isMobile }) => {
  test.skip(isMobile, '表格视图在桌面上用');
  const email = `csv-${Date.now()}@e2e.local`;
  expect((await page.request.post('/api/auth/register', { data: { email, password: 'password123', name: '表格' } })).ok()).toBeTruthy();
  const story = await (await page.request.post('/api/stories', { data: { title: 'CSV 导入', logline: '' } })).json();
  const ops = [
    { op: 'create', entity: 'chapter', id: 'ch_csv1', sortKey: 'i', value: { title: '第一章' } },
    { op: 'create', entity: 'scene', id: 'sc_csv1', parentId: 'ch_csv1', sortKey: 'i', value: { title: '雨夜街头' } },
    { op: 'create', entity: 'scene', id: 'sc_csv2', parentId: 'ch_csv1', sortKey: 'j', value: { title: '旧书店' } },
  ];
  expect((await page.request.post(`/api/stories/${story.id}/ops`, { data: { ops } })).ok()).toBeTruthy();

  await page.goto(`/studio/stories/${story.id}?tab=shots`);
  await page.getByRole('tab', { name: '表格', exact: true }).click();
  const csv = ['序号,镜头编号,章,场,景别,运镜,时长,画面描述,出镜,台词,定稿,id', '1,,第一章,雨夜街头,远景,推,4,霓虹倒映在水洼,,,,', '2,,第一章,旧书店,特写,固定,3,积灰的书脊,,,,', '3,,第二章,清晨,中景,跟,5,她走出家门,,,,'].join('\r\n');
  await page.getByLabel('选择镜头表 CSV').setInputFiles({ name: 'shots.csv', mimeType: 'text/csv', buffer: Buffer.from(`﻿${csv}`) });
  await expect(page.getByText(/导入完成：更新 0 个，新增 3 个镜头，新建 1 个场次/)).toBeVisible();

  await expect
    .poll(async () => {
      const saved = await (await page.request.get(`/api/stories/${story.id}`)).json();
      return saved.data.chapters.map((c: any) => `${c.title}:${c.scenes.map((s: any) => `${s.title}(${s.shots.map((x: any) => x.description).join('|')})`).join(',')}`);
    }, { timeout: 10_000 })
    .toEqual(['第一章:雨夜街头(霓虹倒映在水洼),旧书店(积灰的书脊)', '第二章:清晨(她走出家门)']);
});
