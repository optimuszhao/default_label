// M8a 工作流界面：启动 W1 → 侧栏出现"待你选择"角标 → 挑一张继续 → 运行完成看到产物
import { expect, test } from '@playwright/test';

test('WF-04 工作流：四选一出视频，在运行视图里挑选后继续跑完', async ({ page, isMobile }) => {
  const email = `wf-${Date.now()}@e2e.local`;
  const response = await page.request.post('/api/auth/register', { data: { email, password: 'password123', name: '工作流' } });
  expect(response.ok(), await response.text()).toBeTruthy();
  await page.request.patch('/api/settings', { data: { autoDispatch: true } });

  await page.goto('/studio/workflows');
  await page.getByRole('button', { name: /四选一出视频/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('雨夜霓虹街头，撑伞的少女回眸').fill('海边的红色灯塔');
  await dialog.getByRole('button', { name: '开始', exact: true }).click();
  await expect(dialog).toBeHidden();

  // 4 张候选生成好后进入"等你挑选"
  await expect(page.getByText('等你挑选', { exact: true })).toBeVisible({ timeout: 30_000 });
  if (!isMobile) await expect(page.locator('aside').getByTitle('待你选择')).toHaveText('1');
  const candidates = page.getByRole('button', { name: '候选', exact: true });
  await expect(candidates).toHaveCount(4);
  await candidates.nth(1).click();
  await page.getByRole('button', { name: '用这张继续' }).click();

  await expect(page.getByText('已完成', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('产物', { exact: true })).toBeVisible();
});
