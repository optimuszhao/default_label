// 创作流水像聊天：最早的在上面、最新的在最下面紧挨输入区；打开时停在底部；新提交的作品出现在底部
import { expect, test } from '@playwright/test';

test('CRT 创作流水：最新的在最下面，打开时停在底部，新作品追加到底部', async ({ page }) => {
  const email = `feed-${Date.now()}@e2e.local`;
  expect((await page.request.post('/api/auth/register', { data: { email, password: 'password123', name: '流水' } })).ok()).toBeTruthy();
  const params = { aspectRatio: '1:1', resolution: '1K', width: 1024, height: 1024, count: 1, seed: null };
  for (const prompt of ['第一张 清晨的海', '第二张 午后的街', '第三张 深夜的灯']) {
    await page.request.post('/api/tasks', { data: { type: 't2i', prompt, params, runNow: true } });
    await page.waitForTimeout(30);
  }
  await expect
    .poll(async () => ((await (await page.request.get('/api/tasks')).json()) as { status: string }[]).filter((t) => t.status === 'succeeded').length, { timeout: 30_000 })
    .toBe(3);

  await page.goto('/studio/create');
  const first = page.locator('main').getByText('第一张 清晨的海').first();
  const third = page.locator('main').getByText('第三张 深夜的灯').first();
  await expect(third).toBeVisible();
  const y = async (locator: typeof first) => (await locator.boundingBox())!.y;
  expect(await y(first)).toBeLessThan(await y(third));
  // 停在底部
  await expect.poll(() => page.evaluate(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 200)).toBe(true);

  // 新提交的作品出现在最下面
  await page.request.post('/api/tasks', { data: { type: 't2i', prompt: '第四张 黎明的山', params, runNow: true } });
  const fourth = page.locator('main').getByText('第四张 黎明的山').first();
  await expect(fourth).toBeVisible({ timeout: 15_000 });
  // 新作品会平滑滚到底部：同一时刻量两张卡片的位置
  const [t3, t4] = await page.evaluate(() => ['第三张 深夜的灯', '第四张 黎明的山'].map((text) => [...document.querySelectorAll('main [data-feed-card]')].findIndex((el) => el.textContent?.includes(text))));
  expect(t3).toBeGreaterThanOrEqual(0);
  expect(t3).toBeLessThan(t4);
});

test('CRT 创作流水：往上翻加载更早的作品时，视线停在原处', async ({ page, isMobile }) => {
  test.skip(isMobile, '桌面上测一次即可');
  const email = `feed-old-${Date.now()}@e2e.local`;
  expect((await page.request.post('/api/auth/register', { data: { email, password: 'password123', name: '流水' } })).ok()).toBeTruthy();
  await page.request.patch('/api/settings', { data: { autoDispatch: true } });
  const params = { aspectRatio: '1:1', resolution: '1K', width: 1024, height: 1024, count: 1, seed: null };
  for (let i = 1; i <= 26; i++) {
    await page.request.post('/api/tasks', { data: { type: 't2i', prompt: `作品编号 ${String(i).padStart(2, '0')}`, params } });
    await page.waitForTimeout(15);
  }
  await expect
    .poll(async () => ((await (await page.request.get('/api/tasks?limit=50')).json()) as { status: string }[]).filter((t) => t.status === 'succeeded').length, { timeout: 60_000 })
    .toBe(26);

  await page.goto('/studio/create');
  await expect(page.locator('main').getByText('作品编号 26').first()).toBeVisible();
  // 第一页 20 个：最上面是 07
  const oldestLoaded = page.locator('main').getByText('作品编号 07').first();
  await expect(oldestLoaded).toBeAttached();
  await expect(page.locator('main').getByText('作品编号 06')).toHaveCount(0);
  await oldestLoaded.scrollIntoViewIfNeeded();
  const before = (await oldestLoaded.boundingBox())!.y;
  await expect(page.locator('main').getByText('作品编号 01').first()).toBeAttached({ timeout: 15_000 });
  await page.waitForTimeout(400);
  const after = (await oldestLoaded.boundingBox())!.y;
  expect(Math.abs(after - before)).toBeLessThan(80);
  const first = (await page.locator('main').getByText('作品编号 01').first().boundingBox())!.y;
  expect(first).toBeLessThan(after);
});
