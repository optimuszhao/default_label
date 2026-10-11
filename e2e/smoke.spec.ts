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

/** 手机上创作面板默认收起成一行，先展开 */
async function openComposer(page: Page) {
  const expand = page.getByRole('button', { name: '展开创作面板' });
  const textarea = page.getByRole('textbox', { name: '提示词', exact: true });
  await expect(textarea.or(expand)).toBeVisible();
  if (await expand.isVisible()) await expand.click();
  await expect(page.getByRole('textbox', { name: '提示词', exact: true })).toBeVisible();
}

async function loginAdmin(page: Page) {
  const response = await page.request.post('/api/auth/login', { data: { email: 'admin@e2e.local', password: 'password123' } });
  if (!response.ok()) await register(page, 'admin@e2e.local');
}

test('创作台按算子能力显示控件，文生视频按原生尺寸提交并完成', async ({ page }) => {
  await register(page);
  await page.goto('/studio/create');
  await openComposer(page);

  // 图片模式：comfyweb 没有 CFG
  await page.getByRole('button', { name: '高级参数' }).click();
  await expect(page.getByText('步数（留空用默认）')).toBeVisible();
  await expect(page.getByText('CFG', { exact: true })).toHaveCount(0);
  await dismiss(page);

  // 视频模式：尺寸固定 1344×768，不支持反向提示词
  await page.getByRole('tablist', { name: '创作模式' }).getByRole('tab', { name: '视频' }).click();
  await expect(page.getByRole('button', { name: /16:9 · 1344×768/ })).toBeVisible();
  await page.getByRole('button', { name: '高级参数' }).click();
  await expect(page.getByText(/不支持反向提示词/)).toBeVisible();
  await dismiss(page);

  await page.getByRole('textbox', { name: '提示词', exact: true }).fill('海浪拍打礁石，慢镜头');
  await page.getByRole('button', { name: '立即生成' }).last().click();
  await expect(page.getByText('已完成').first()).toBeVisible({ timeout: 30_000 });

  const tasks = await (await page.request.get('/api/tasks')).json();
  expect(tasks[0].params.width).toBe(1344);
  expect(tasks[0].params.height).toBe(768);
});

test('创作台选预设：编译进提示词，配方随任务保存', async ({ page }) => {
  await register(page);
  await page.goto('/studio/create');
  await openComposer(page);
  await page.getByRole('textbox', { name: '提示词', exact: true }).fill('一只橘猫趴在窗台上');
  await page.getByRole('button', { name: /^预设/ }).click();
  const chip = page.locator('button[aria-pressed]', { hasText: '电影感' }).first();
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '去掉电影感' })).toBeVisible();

  await page.getByRole('button', { name: '立即生成' }).last().click();
  await expect(page.getByText('已完成').first()).toBeVisible({ timeout: 30_000 });
  const [task] = await (await page.request.get('/api/tasks')).json();
  expect(task.recipe.presets).toContain('style-cinematic');
  expect(task.prompt).toContain('一只橘猫趴在窗台上');
  expect(task.prompt).toContain('电影感画面');
});

test('灵感页：模板套用到创作台，或直接生成', async ({ page }) => {
  await register(page);
  await page.goto('/studio/inspire');
  await page.getByRole('button', { name: '打开模板 电影海报' }).first().click();
  await expect(page.getByText('最终提示词预览')).toBeVisible();
  await page.getByRole('button', { name: /套用到创作台/ }).click();
  await expect(page).toHaveURL(/\/studio\/create/);
  await expect(page.getByText(/电影海报/).first()).toBeVisible();

  await page.goto('/studio/inspire');
  await page.getByRole('button', { name: '打开模板 电影海报' }).first().click();
  await page.getByRole('button', { name: '直接生成' }).click();
  await expect
    .poll(async () => ((await (await page.request.get('/api/tasks')).json()) as { recipe?: { templateId?: string } }[])[0]?.recipe?.templateId, { timeout: 15_000 })
    .toBe('movie-poster');
});

test('后台内容管理：下架模板后用户端看不到', async ({ page }) => {
  await loginAdmin(page);
  const id = `e2e-${Date.now()}-${++seq}`;
  const name = `测试${id.slice(-9)}`;
  const created = await page.request.post('/api/admin/templates', { data: { id, name, mode: 'image', body: '{主体}在雨中奔跑' } });
  expect(created.ok(), await created.text()).toBeTruthy();
  const listed = async () => ((await (await page.request.get('/api/templates')).json()) as { id: string }[]).some((t) => t.id === id);
  expect(await listed()).toBe(true);

  await page.goto('/admin/content');
  await page.getByPlaceholder('名称、分类或正文').fill(name);
  await page.getByRole('switch', { name: `启用 ${name}` }).click();
  await expect(page.getByText('已下架')).toBeVisible();
  expect(await listed()).toBe(false);

  // 预设页可以切换
  await page.getByRole('tab', { name: '预设' }).click();
  await expect(page.getByRole('button', { name: '编辑 电影感' })).toBeVisible();
});

test('管理后台：查看算子与令牌、立即校验、重新获取、开关维护模式；普通用户进不去', async ({ page, browser }) => {
  await register(page, `admin@e2e.local`).catch(async () => {
    // 两个视口共用一个服务：第二次直接登录
    await page.request.post('/api/auth/login', { data: { email: 'admin@e2e.local', password: 'password123' } });
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await page.goto('/admin/operators/op_default');
  await expect(page.getByRole('heading', { name: '默认算子（ComfyUI）' })).toBeVisible();
  await page.getByRole('tab', { name: '凭证与令牌' }).click();
  await page.getByRole('button', { name: '重新获取' }).click();
  await expect(page.getByText('已重新获取令牌')).toBeVisible();
  await page.getByRole('button', { name: '立即校验' }).click();
  await expect(page.getByText('令牌有效').first()).toBeVisible();
  await expect(page.getByText('按接口文档的 72 小时推算')).toBeVisible();

  await page.getByRole('tab', { name: '概览' }).click();
  await page.getByRole('switch', { name: '维护模式' }).click();
  await expect(page.getByText('已进入维护')).toBeVisible();
  await page.getByRole('switch', { name: '维护模式' }).click();
  await expect(page.getByText('已结束维护')).toBeVisible();

  const other = await browser.newPage();
  await register(other);
  await other.goto('/admin');
  await expect(other).toHaveURL(/\/studio\/create/);
  expect((await other.request.get('/api/admin/overview')).status()).toBe(404);
  await other.close();
});

test('PWA：清单、图标和 Service Worker 都能取到，SW 不缓存', async ({ page }) => {
  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBeTruthy();
  const json = await manifest.json();
  expect(json.start_url).toBe('/studio/create');
  for (const icon of json.icons) expect((await page.request.get(icon.src)).ok()).toBeTruthy();
  const sw = await page.request.get('/sw.js');
  expect(sw.ok()).toBeTruthy();
  expect(sw.headers()['cache-control']).toBe('no-cache');
  await page.goto('/');
  await expect(page.locator('link[rel=manifest]')).toHaveAttribute('href', '/manifest.webmanifest');
});

test('STY-05 两个标签页同时编辑不同字段：互相实时同步，两边的修改都保留；可以撤销', async ({ page, context }) => {
  await register(page);
  const story = await (await page.request.post('/api/stories', { data: { title: '同步', logline: '' } })).json();
  await page.goto(`/studio/stories/${story.id}?tab=setup`);
  const second = await context.newPage();
  await second.goto(`/studio/stories/${story.id}?tab=setup`);

  await page.getByRole('textbox', { name: '故事名称' }).fill('第一个标签页改的标题');
  await expect(page.getByRole('status', { name: '已保存' })).toBeVisible();
  await expect(second.getByRole('textbox', { name: '故事名称' })).toHaveValue('第一个标签页改的标题');

  const tone = (p: typeof page) => p.getByPlaceholder('例如：温暖而带着忧伤 / 紧张压抑 / 轻松幽默');
  await tone(second).fill('紧张压抑');
  await expect(second.getByRole('status', { name: '已保存' })).toBeVisible();
  await expect(tone(page)).toHaveValue('紧张压抑');
  await expect(page.getByRole('textbox', { name: '故事名称' })).toHaveValue('第一个标签页改的标题');

  // 撤销：第二个标签页撤回自己的修改
  await second.getByRole('heading').first().click();
  await second.getByRole('button', { name: /撤销/ }).click();
  await expect(tone(second)).toHaveValue('');
  await expect(second.getByRole('status', { name: '已保存' })).toBeVisible();
  await expect(tone(page)).toHaveValue('');
  const saved = await (await page.request.get(`/api/stories/${story.id}`)).json();
  expect(saved.title).toBe('第一个标签页改的标题');
  expect(saved.data.tone).toBe('');
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

  // 两条路都算对：关页面时的 keepalive 保存送达（部分 Chromium 版本里它不受断网模拟限制），
  // 或者没送达、重新打开时从本地草稿重放。要验证的是修改不会丢。
  const reopened = await context.newPage();
  await reopened.goto(`/studio/stories/${story.id}?tab=setup`);
  await expect(reopened.getByRole('textbox', { name: '故事名称' })).toHaveValue('离线时改的标题');
  await expect(reopened.getByRole('status', { name: '已保存' })).toBeVisible();
  const saved = await (await reopened.request.get(`/api/stories/${story.id}`)).json();
  expect(saved.title).toBe('离线时改的标题');
});

test('STY-05 保存失败的修改留在本机队列：刷新后在界面上重放，恢复后自动提交', async ({ page }) => {
  await register(page);
  const story = await (await page.request.post('/api/stories', { data: { title: '队列', logline: '' } })).json();
  await page.goto(`/studio/stories/${story.id}?tab=setup`);
  await expect(page.getByRole('textbox', { name: '故事名称' })).toHaveValue('队列');
  const block = (route: import('@playwright/test').Route) => route.abort();
  await page.route('**/api/stories/*/ops', block);
  await page.getByRole('textbox', { name: '故事名称' }).fill('没送出去的标题');
  await expect(page.getByRole('status', { name: '保存失败' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('已恢复上次未保存的修改')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '故事名称' })).toHaveValue('没送出去的标题');
  await page.unroute('**/api/stories/*/ops', block);
  await expect(page.getByRole('status', { name: '已保存' })).toBeVisible({ timeout: 20_000 });
  const saved = await (await page.request.get(`/api/stories/${story.id}`)).json();
  expect(saved.title).toBe('没送出去的标题');
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
    ['inspire', '/studio/inspire'],
    ['stories', '/studio/stories'],
    ['story-editor', `/studio/stories/${story.id}`],
    ['workflows', '/studio/workflows'],
    ['queue', '/studio/queue'],
    ['assets', '/studio/assets'],
    ['settings', '/studio/settings'],
  ];
  // 后台页面用管理员账号截图
  const adminPages: [string, string][] = [
    ['admin-overview', '/admin'],
    ['admin-operators', '/admin/operators'],
    ['admin-operator-detail', '/admin/operators/op_default'],
    ['admin-tasks', '/admin/tasks'],
    ['admin-users', '/admin/users'],
    ['admin-content', '/admin/content'],
    ['admin-workflows', '/admin/workflows'],
    ['admin-backups', '/admin/backups'],
    ['admin-audit', '/admin/audit'],
  ];
  for (const [name, url] of pages) {
    await page.goto(url);
    // 页面有 SSE 长连接，网络不会空闲；等加载完成再稍等渲染
    await page.waitForLoadState('load');
    await page.waitForTimeout(600);
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  }
  await page.request.post('/api/auth/logout');
  await page.request.post('/api/auth/login', { data: { email: 'admin@e2e.local', password: 'password123' } }).then(async (response) => {
    if (!response.ok()) await register(page, 'admin@e2e.local');
  });
  for (const [name, url] of adminPages) {
    await page.goto(url);
    await page.waitForLoadState('load');
    await page.waitForTimeout(600);
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
