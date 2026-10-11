// M6 资产库 2.0 界面：详情抽屉、评分和标签、多选批量移动到文件夹、回收站；手机上点开详情和勾选多选
import { expect, test, type Page } from '@playwright/test';

let seq = 0;

async function register(page: Page) {
  const email = `lib-${Date.now()}-${++seq}@e2e.local`;
  const response = await page.request.post('/api/auth/register', { data: { email, password: 'password123', name: '资产' } });
  expect(response.ok(), await response.text()).toBeTruthy();
  await page.request.patch('/api/settings', { data: { autoDispatch: true } });
}

async function generate(page: Page, prompts: string[]) {
  const params = { aspectRatio: '1:1', resolution: '1K', width: 1024, height: 1024, count: 1, seed: null };
  for (const prompt of prompts) {
    await page.request.post('/api/tasks', { data: { type: 't2i', prompt, params, runNow: true } });
  }
  await expect
    .poll(async () => ((await (await page.request.get('/api/tasks')).json()) as { status: string }[]).filter((t) => t.status === 'succeeded').length, { timeout: 30_000 })
    .toBe(prompts.length);
}

test('AST-09 资产库：详情里评分加标签，多选移动到文件夹，移入回收站再恢复', async ({ page, isMobile }) => {
  test.skip(isMobile, '多选快捷键只在桌面上');
  await register(page);
  await generate(page, ['网格一号 雨夜街头', '网格二号 拉面店', '网格三号 水墨山水']);
  await page.request.post('/api/folders', { data: { name: '第一集' } });
  await page.goto('/studio/assets');

  const tile = (name: string) => page.getByRole('button', { name, exact: true });
  await expect(tile('网格一号 雨夜街头')).toBeVisible();
  await expect(page.getByText('3 个素材', { exact: true })).toBeVisible();

  // 单击打开详情，评分 4 星、加标签
  await tile('网格一号 雨夜街头').click();
  await page.getByRole('tab', { name: '整理' }).click();
  await page.getByRole('button', { name: '4 星' }).click();
  await page.getByPlaceholder('加标签，回车').fill('女主');
  await page.getByPlaceholder('加标签，回车').press('Enter');
  await expect(page.getByText('#女主')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '资产库导航' }).getByRole('button', { name: '女主' })).toBeVisible();

  // 搜索
  await page.getByPlaceholder('搜索提示词、备注、标签、文件名').fill('拉面');
  await expect(page.getByText('1 个素材', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(page.getByText('3 个素材', { exact: true })).toBeVisible();

  // ⌘ 单击多选两张 → 移动到"第一集"
  await page.getByRole('button', { name: '关闭详情' }).click();
  await tile('网格二号 拉面店').click({ modifiers: ['ControlOrMeta'] });
  await tile('网格三号 水墨山水').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByText('已选 2 个')).toBeVisible();
  const bar = page.getByRole('toolbar', { name: '批量操作' });
  await bar.getByRole('button', { name: '移动到' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /第一集/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确定' }).click();
  await expect(page.getByText('已处理 2 个素材')).toBeVisible();
  await page.getByRole('navigation', { name: '资产库导航' }).getByRole('button', { name: /第一集/ }).click();
  await expect(page.getByText('2 个素材', { exact: true })).toBeVisible();

  // 选一张移入回收站，再到回收站里恢复
  await tile('网格二号 拉面店').click({ modifiers: ['ControlOrMeta'] });
  await bar.getByRole('button', { name: '回收站', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移入回收站' }).click();
  await expect(page.getByText('1 个素材', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '资产库导航' }).getByRole('button', { name: /^回收站/ }).click();
  await expect(tile('网格二号 拉面店')).toBeVisible();
  await tile('网格二号 拉面店').click();
  await page.getByRole('button', { name: '恢复' }).click();
  await expect(page.getByText('已恢复')).toBeVisible();
  await expect(page.getByText('回收站是空的')).toBeVisible();
});

test('AST-09 手机：点开详情面板，勾选多选出现批量操作条', async ({ page, isMobile }) => {
  test.skip(!isMobile, '只在手机视口');
  await register(page);
  await generate(page, ['手机一号', '手机二号']);
  await page.goto('/studio/assets');
  await page.getByRole('button', { name: '手机一号', exact: true }).click();
  await expect(page.getByRole('tab', { name: '整理' })).toBeVisible();
  await page.getByRole('button', { name: '关闭详情' }).click();
  await page.getByRole('button', { name: '选择' }).first().click();
  await expect(page.getByText('已选 1 个')).toBeVisible();
  // 侧栏在手机上是面板
  await page.getByRole('button', { name: '退出多选' }).click();
  await page.getByRole('button', { name: '打开资产库导航' }).click();
  await expect(page.getByRole('navigation', { name: '资产库导航' })).toBeVisible();
});
