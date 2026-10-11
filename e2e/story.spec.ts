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

test('STY-11 分镜表格：切到表格视图，从 Excel 粘贴几行变成镜头', async ({ page }) => {
  await register(page);
  const id = await seedStory(page);
  await page.goto(`/studio/stories/${id}?tab=shots`);
  await page.getByRole('tablist', { name: '分镜视图' }).getByRole('tab', { name: '表格' }).click();
  const table = page.getByLabel('分镜表格');
  await expect(table.getByText('共 2 个镜头')).toBeVisible();
  await table.evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/plain', '景别\t运镜\t时长\t画面描述\n近景\t推\t3\t林昔的眼睛反射着霓虹\n特写\t固定\t2\t雨滴落在收音机上\n');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
  await expect(table.getByText('共 4 个镜头')).toBeVisible();
  await expect(page.getByRole('status', { name: '已保存' })).toBeVisible();
  const story = await (await page.request.get(`/api/stories/${id}`)).json();
  const shots = story.data.chapters[0].scenes[0].shots;
  expect(shots.at(-1).description).toBe('雨滴落在收音机上');
  expect(shots.at(-2).shotSize).toBe('近景');
});

test('STY-12 绘本模板：没有成片步骤，换成图文排版；EXP-07 自动排版并导出长图；STY-13 列表里复制和归档', async ({ page, isMobile }) => {
  await register(page);
  await page.goto('/studio/stories');
  await page.getByRole('button', { name: '新建故事' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /儿童绘本/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: '创建并开始' }).click();
  await expect(page).toHaveURL(/\/studio\/stories\/s_/);
  const nav = page.getByRole('navigation', { name: '创作步骤' });
  await expect(nav.getByRole('button', { name: /图文排版/ })).toBeVisible();
  await expect(nav.getByRole('button', { name: /成片/ })).toHaveCount(0);
  const id = page.url().split('/stories/')[1].split('?')[0];

  // 加一个镜头再排版
  const story = await (await page.request.get(`/api/stories/${id}`)).json();
  const sceneId = story.data.chapters[0].scenes[0].id;
  await page.request.post(`/api/stories/${id}/ops`, {
    data: { ops: [{ op: 'create', entity: 'shot', id: `sh_pb${Date.now()}`, parentId: sceneId, sortKey: 'i', value: { shotSize: '全景', cameraMove: '固定', description: '小兔子在草地上', duration: 5 } }] },
  });
  await page.goto(`/studio/stories/${id}?tab=layout`);
  await page.getByRole('button', { name: '按分镜自动排版' }).click();
  await expect(page.getByRole('textbox', { name: '绘本文字' }).first()).toBeVisible();
  if (!isMobile) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出长图' }).click();
    expect((await download).suggestedFilename()).toMatch(/绘本\.png$/);
  }
  await expect.poll(async () => (await (await page.request.get(`/api/stories/${id}/layouts`)).json()).length).toBe(1);

  // 打印视图
  await page.goto(`/print/stories/${id}?mode=storyboard`);
  await expect(page.getByText('分镜表 · 1 个镜头')).toBeVisible();

  // 列表：复制、归档
  await page.goto('/studio/stories');
  await page.getByRole('button', { name: '更多操作' }).first().click();
  await page.getByRole('menuitem', { name: '复制故事' }).click();
  await expect(page).toHaveURL(/\/studio\/stories\/s_/);
  await page.goto('/studio/stories');
  await expect(page.getByText(/副本/)).toBeVisible();
  await page.getByRole('button', { name: '更多操作' }).first().click();
  await page.getByRole('menuitem', { name: '归档' }).click();
  await page.getByRole('tablist', { name: '故事状态' }).getByRole('tab', { name: '已归档' }).click();
  await expect(page.getByRole('link').filter({ hasText: /儿童绘本/ })).toHaveCount(1);
});
