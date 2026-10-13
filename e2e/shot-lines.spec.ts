// 分镜卡片的"本镜台词"：默认只显示本镜头的台词；展开"选择台词"能看到哪些句子已分给别的镜头；
// 场次标题提示还有几句台词没分配，可以直接分给某个镜头。顶部步骤条标出当前步骤和进展。
import { expect, test } from '@playwright/test';

test('STY 本镜台词：只显示本镜的句子，标出已用于别的镜头，未分配的台词可以直接分配', async ({ page, isMobile }) => {
  test.skip(isMobile, '桌面上测一次即可');
  const email = `lines-${Date.now()}@e2e.local`;
  expect((await page.request.post('/api/auth/register', { data: { email, password: 'password123', name: '台词' } })).ok()).toBeTruthy();
  const story = await (await page.request.post('/api/stories', { data: { title: '雨夜重逢', logline: '' } })).json();
  const t = Date.now().toString(36);
  const ops = [
    { op: 'create', entity: 'character', id: `ca_${t}`, sortKey: 'i', value: { name: '林昔', appearance: '短发' } },
    { op: 'create', entity: 'chapter', id: `ch_${t}`, sortKey: 'i', value: { title: '第一章' } },
    { op: 'create', entity: 'scene', id: `sc_${t}`, parentId: `ch_${t}`, sortKey: 'i', value: { title: '雨夜街头' } },
    { op: 'create', entity: 'line', id: `d1_${t}`, parentId: `sc_${t}`, sortKey: 'a', value: { characterId: null, text: '雨一直下着', emotion: '' } },
    { op: 'create', entity: 'line', id: `d2_${t}`, parentId: `sc_${t}`, sortKey: 'b', value: { characterId: `ca_${t}`, text: '姐姐？是你吗？', emotion: '' } },
    { op: 'create', entity: 'line', id: `d3_${t}`, parentId: `sc_${t}`, sortKey: 'c', value: { characterId: `ca_${t}`, text: '我一直在找你', emotion: '' } },
    { op: 'create', entity: 'shot', id: `s1_${t}`, parentId: `sc_${t}`, sortKey: 'a', value: { shotSize: '远景', cameraMove: '推', description: '雨夜街头', duration: 5, dialogueIds: [`d1_${t}`] } },
    { op: 'create', entity: 'shot', id: `s2_${t}`, parentId: `sc_${t}`, sortKey: 'b', value: { shotSize: '近景', cameraMove: '固定', description: '她回头', duration: 4, dialogueIds: [] } },
  ];
  expect((await page.request.post(`/api/stories/${story.id}/ops`, { data: { ops } })).ok()).toBeTruthy();

  await page.goto(`/studio/stories/${story.id}?tab=shots`);
  const tab = page.getByRole('tab', { name: '卡片', exact: true });
  if (await tab.isVisible()) await tab.click();
  await expect(page.getByRole('navigation', { name: '创作步骤' }).locator('[aria-current="step"]')).toContainText('分镜');

  const [first, second] = [page.getByTestId('shot-lines').nth(0), page.getByTestId('shot-lines').nth(1)];
  await expect(first).toContainText('雨一直下着');
  await expect(first).not.toContainText('姐姐？是你吗？');
  await expect(second).toContainText('本镜没有台词');

  // 场次里还有 2 句没分配：把"姐姐？是你吗？"分给第 2 个镜头
  await page.getByRole('button', { name: '还有 2 句台词没分配到镜头' }).click();
  const unassigned = page.getByRole('list', { name: '未分配的台词' });
  await unassigned.getByRole('listitem').filter({ hasText: '姐姐？是你吗？' }).getByLabel('分配到镜头').selectOption(`s2_${t}`);
  await expect(second).toContainText('姐姐？是你吗？');
  await expect(page.getByRole('button', { name: '还有 1 句台词没分配到镜头' })).toBeVisible();

  // 展开第 2 个镜头的整场台词：第 1 句标着已用于 #01
  await second.getByRole('button', { name: '选择台词' }).click();
  await expect(second.getByRole('button', { name: /雨一直下着/ })).toContainText('已用于 #01');
  await second.getByRole('button', { name: /我一直在找你/ }).click();
  await expect(page.getByRole('button', { name: /句台词没分配到镜头/ })).toHaveCount(0);

  await expect
    .poll(async () => (await (await page.request.get(`/api/stories/${story.id}`)).json()).data.chapters[0].scenes[0].shots[1].dialogueIds, { timeout: 10_000 })
    .toEqual([`d2_${t}`, `d3_${t}`]);
});
