// 冒烟测试：桌面（1440）和手机（375）两个视口各跑一遍。
// 对接的是假算子（comfyweb 协议），见 e2e/serve.ts。
import { expect, test, type Page } from '@playwright/test';

let seq = 0;

/** 关掉弹出层：模拟在空白处按下指针 */
async function dismiss(page: Page) {
  await page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
}

async function register(page: Page, email = `e2e-${Date.now()}-${++seq}@e2e.local`) {
  const response = await page.request.post('/api/auth/register', { data: { email, password: 'password123', name: '测试' } });
  expect(response.ok(), await response.text()).toBeTruthy();
  await page.request.patch('/api/settings', { data: { autoDispatch: true } });
  return email;
}

test('创作台按算子能力显示控件，文生视频按原生尺寸提交并完成', async ({ page }) => {
  await register(page);
  await page.goto('/studio/create');

  // 图片模式：comfyweb 没有 CFG
  await page.getByRole('button', { name: '高级参数' }).click();
  await expect(page.getByText('步数', { exact: true })).toBeVisible();
  await expect(page.getByText('CFG', { exact: true })).toHaveCount(0);
  await dismiss(page);

  // 视频模式：尺寸固定 1344×768，没有反向提示词
  await page.getByRole('tab', { name: '视频' }).click();
  await expect(page.getByRole('button', { name: /16:9 · 1344×768/ })).toBeVisible();
  await page.getByRole('button', { name: '高级参数' }).click();
  await expect(page.getByText('反向提示词')).toHaveCount(0);
  await dismiss(page);

  await page.locator('textarea').first().fill('海浪拍打礁石，慢镜头');
  await page.getByRole('button', { name: '立即生成' }).click();
  await expect(page.getByText('已完成').first()).toBeVisible({ timeout: 30_000 });

  const tasks = await (await page.request.get('/api/tasks')).json();
  expect(tasks[0].params.width).toBe(1344);
  expect(tasks[0].params.height).toBe(768);
});

test('管理员在设置页能看到令牌状态并校验，普通用户看不到', async ({ page, browser }) => {
  await register(page, `admin@e2e.local`).catch(async () => {
    // 两个视口共用一个服务：第二次直接登录
    await page.request.post('/api/auth/login', { data: { email: 'admin@e2e.local', password: 'password123' } });
  });
  await page.goto('/studio/settings');
  await expect(page.getByRole('heading', { name: '算子令牌' })).toBeVisible();
  await page.getByRole('button', { name: '立即校验' }).click();
  await expect(page.getByText('令牌有效')).toBeVisible();
  await expect(page.getByText('按接口文档的 72 小时推算')).toBeVisible();

  const other = await browser.newPage();
  await register(other);
  await other.goto('/studio/settings');
  await expect(other.getByRole('heading', { name: '自动调度' })).toBeVisible();
  await expect(other.getByRole('heading', { name: '算子令牌' })).toHaveCount(0);
  await other.close();
});

test('两个标签页同时编辑故事：后保存的一方看到冲突提示', async ({ page, context }) => {
  await register(page);
  const story = await (await page.request.post('/api/stories', { data: { title: '冲突', logline: '' } })).json();
  await page.goto(`/studio/stories/${story.id}?tab=setup`);
  const second = await context.newPage();
  await second.goto(`/studio/stories/${story.id}?tab=setup`);

  const title = page.getByRole('textbox', { name: '故事名称' });
  await title.fill('第一个标签页');
  await expect(page.getByRole('status', { name: '已保存' })).toBeVisible();

  await second.getByRole('textbox', { name: '故事名称' }).fill('第二个标签页');
  await expect(second.getByText('这个故事已在其他设备或标签页更新')).toBeVisible();
  await second.getByRole('button', { name: '载入最新版本' }).click();
  await expect(second.getByRole('textbox', { name: '故事名称' })).toHaveValue('第一个标签页');
});

test('断网时的修改：关掉页面再打开，会从本地重放并保存', async ({ page, context }) => {
  await register(page);
  const story = await (await page.request.post('/api/stories', { data: { title: '离线', logline: '' } })).json();
  await page.goto(`/studio/stories/${story.id}?tab=setup`);
  await expect(page.getByRole('textbox', { name: '故事名称' })).toHaveValue('离线');

  await context.setOffline(true);
  await page.getByRole('textbox', { name: '故事名称' }).fill('离线时改的标题');
  await expect(page.getByRole('status', { name: '保存失败' })).toBeVisible();
  await page.close();
  await context.setOffline(false);

  const reopened = await context.newPage();
  await reopened.goto(`/studio/stories/${story.id}?tab=setup`);
  await expect(reopened.getByText('已恢复上次未保存的修改')).toBeVisible();
  await expect(reopened.getByRole('textbox', { name: '故事名称' })).toHaveValue('离线时改的标题');
  await expect(reopened.getByRole('status', { name: '已保存' })).toBeVisible();
  const saved = await (await reopened.request.get(`/api/stories/${story.id}`)).json();
  expect(saved.title).toBe('离线时改的标题');
});

test('每个页面都能打开，没有控制台报错，并留存截图', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${page.url()} ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`${page.url()} ${error.message}`));

  await page.goto('/');
  await page.screenshot({ path: testInfo.outputPath('landing.png') });
  await page.goto('/login');
  await page.screenshot({ path: testInfo.outputPath('login.png') });

  await register(page);
  const story = await (await page.request.post('/api/stories', { data: { title: '截图', logline: '' } })).json();
  const pages: [string, string][] = [
    ['create', '/studio/create'],
    ['stories', '/studio/stories'],
    ['story-editor', `/studio/stories/${story.id}`],
    ['queue', '/studio/queue'],
    ['assets', '/studio/assets'],
    ['settings', '/studio/settings'],
  ];
  for (const [name, url] of pages) {
    await page.goto(url);
    // 页面有 SSE 长连接，网络不会空闲；等加载完成再稍等渲染
    await page.waitForLoadState('load');
    await page.waitForTimeout(600);
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
