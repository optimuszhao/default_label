// M7b 故事生产界面：镜头检查器与提示词分段预览、定稿、批量生成试算、设定库、系列看板
import { expect, test, type Page } from '@playwright/test';

let seq = 0;

async function register(page: Page) {
  const email = `story-${Date.now()}-${++seq}@e2e.local`;
  const response = await page.request.post('/api/auth/register', { data: { email, password: 'password123', name: '故事' } });
  expect(response.ok(), await response.text()).toBeTruthy();
  await page.request.patch('/api/settings', { data: { autoDispatch: true } });
}

/** 用增量接口建一个带一场两镜的故事 */
async function seedStory(page: Page): Promise<string> {
  const story = await (await page.request.post('/api/stories', { data: { title: '分镜测试', logline: '' } })).json();
  const t = `${Date.now().toString(36)}${++seq}`;
  const ops = [
    { op: 'create', entity: 'character', id: `c_${t}`, sortKey: 'i', value: { name: '林昔', role: '主角', appearance: '短发少女，红色雨衣' } },
    { op: 'create', entity: 'element', id: `e_${t}`, sortKey: 'i', value: { kind: 'prop', name: '收音机', snippet: '掉漆木壳' } },
    { op: 'create', entity: 'chapter', id: `ch_${t}`, sortKey: 'i', value: { title: '第一章' } },
    { op: 'create', entity: 'scene', id: `sc_${t}`, parentId: `ch_${t}`, sortKey: 'i', value: { title: '雨夜街头', location: '旧城区', time: '夜' } },
    { op: 'create', entity: 'shot', id: `sh1_${t}`, parentId: `sc_${t}`, sortKey: 'a', value: { shotSize: '远景', cameraMove: '推', description: '林昔撑伞走过霓虹街头', duration: 5, characterIds: [`c_${t}`] } },
    { op: 'create', entity: 'shot', id: `sh2_${t}`, parentId: `sc_${t}`, sortKey: 'b', value: { shotSize: '特写', cameraMove: '固定', description: '收音机的指示灯亮起', duration: 4 } },
  ];
  const result = await page.request.post(`/api/stories/${story.id}/ops`, { data: { ops } });
  expect(result.ok(), await result.text()).toBeTruthy();
  return story.id;
}

test('STY-08 镜头检查器：分段预览最终提示词；定稿；批量生成先试算再提交', async ({ page }) => {
  await register(page);
  const id = await seedStory(page);
  await page.goto(`/studio/stories/${id}?tab=shots`);
  await expect(page.getByRole('textbox', { name: '画面描述' }).first()).toHaveValue('林昔撑伞走过霓虹街头');

  // 检查器：最终提示词分段显示，角色外貌已拼进去
  await page.getByRole('button', { name: '检查器' }).first().click();
  await expect(page.getByText(/最终提示词（\d+ 字）/)).toBeVisible();
  await expect(page.getByText('出镜角色：林昔（短发少女，红色雨衣）。')).toBeVisible();

  // @ 提及道具：自动加为出镜
  const description = page.getByRole('textbox', { name: '画面描述' }).nth(1);
  await description.fill('@收音');
  await page.getByRole('listbox', { name: '提及角色或设定' }).getByRole('button', { name: /收音机/ }).click();
  await expect(description).toHaveValue('@收音机 ');
  await expect(page.locator('button[data-active="true"]', { hasText: '收音机' }).first()).toBeVisible();

  // 定稿第二镜
  await page.getByRole('button', { name: '定稿' }).nth(1).click();
  await expect(page.getByRole('button', { name: '已定稿' })).toBeVisible();
  await expect(page.getByRole('status', { name: '已保存' })).toBeVisible();

  // 批量生成：试算显示任务数和跳过的定稿镜头，提交后加入队列
  await page.getByRole('button', { name: '批量生成…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/将创建 1 个任务/)).toBeVisible();
  await expect(dialog.getByText(/已定稿 1/)).toBeVisible();
  await dialog.getByRole('tab', { name: '先关键帧再视频' }).click();
  await expect(dialog.getByText(/关键帧完成后再自动加入 1 个视频/)).toBeVisible();
  await dialog.getByRole('button', { name: '开始生成' }).click();
  await expect(page.getByText(/已加入 1 个任务/)).toBeVisible();
  const tasks = await (await page.request.get(`/api/tasks?storyId=${id}`)).json();
  expect(tasks.length).toBeGreaterThanOrEqual(1);
});

test('STY-07 设定库：角色、地点、道具分区；STY-17 系列看板和新建一集', async ({ page, isMobile }) => {
  await register(page);
  const id = await seedStory(page);
  await page.goto(`/studio/stories/${id}?tab=characters`);
  await expect(page.getByRole('textbox', { name: '角色名' })).toHaveValue('林昔');
  await page.getByRole('tab', { name: /道具/ }).click();
  await expect(page.getByRole('textbox', { name: '道具名' })).toHaveValue('收音机');

  const series = await (await page.request.post('/api/series', { data: { title: '回声之城', settings: { visualStyle: '水彩绘本' } } })).json();
  await page.goto(`/studio/series/${series.id}`);
  await expect(page.getByRole('heading', { name: '回声之城' })).toBeVisible();
  await page.getByRole('button', { name: '新建第 1 集' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '创建并打开' }).click();
  await expect(page).toHaveURL(/\/studio\/stories\//);
  // 手机上标题栏放不下系列标签
  if (!isMobile) await expect(page.getByRole('link', { name: /回声之城 · 第 1 集/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '故事名称' })).toHaveValue('第 1 集');
});
