// M8b 成片预览 v2：字幕、审片备注（M）、待返工（R）、一键配音（模拟）、渲染成片试算；故事包导出后从故事列表导入
import { expect, test, type Page } from '@playwright/test';

let seq = 0;

async function register(page: Page) {
  const email = `film-${Date.now()}-${++seq}@e2e.local`;
  const response = await page.request.post('/api/auth/register', { data: { email, password: 'password123', name: '成片' } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function seedStory(page: Page): Promise<string> {
  const story = await (await page.request.post('/api/stories', { data: { title: '成片预览', logline: '' } })).json();
  const t = `${Date.now().toString(36)}${++seq}`;
  const ops = [
    { op: 'create', entity: 'character', id: `c_${t}`, sortKey: 'i', value: { name: '林昔', appearance: '短发' } },
    { op: 'create', entity: 'chapter', id: `ch_${t}`, sortKey: 'i', value: { title: '第一章' } },
    { op: 'create', entity: 'scene', id: `sc_${t}`, parentId: `ch_${t}`, sortKey: 'i', value: { title: '雨夜', location: '', time: '' } },
    { op: 'create', entity: 'line', id: `d1_${t}`, parentId: `sc_${t}`, sortKey: 'i', value: { characterId: `c_${t}`, text: '你终于来了', emotion: '' } },
    { op: 'create', entity: 'line', id: `d2_${t}`, parentId: `sc_${t}`, sortKey: 'j', value: { characterId: null, text: '雨一直下着', emotion: '' } },
    { op: 'create', entity: 'shot', id: `s1_${t}`, parentId: `sc_${t}`, sortKey: 'a', value: { shotSize: '中景', cameraMove: '固定', description: '少女站在门口', duration: 3, dialogueIds: [`d1_${t}`] } },
    { op: 'create', entity: 'shot', id: `s2_${t}`, parentId: `sc_${t}`, sortKey: 'b', value: { shotSize: '远景', cameraMove: '摇', description: '雨中的街道', duration: 3, dialogueIds: [`d2_${t}`] } },
  ];
  const result = await page.request.post(`/api/stories/${story.id}/ops`, { data: { ops } });
  expect(result.ok(), await result.text()).toBeTruthy();
  return story.id;
}

test('EXP-02 成片预览：字幕、M 加备注、R 待返工、模拟配音、渲染试算', async ({ page, isMobile }) => {
  await register(page);
  const id = await seedStory(page);
  await page.goto(`/studio/stories/${id}?tab=preview`);
  await expect(page.getByTestId('subtitles')).toContainText('你终于来了');

  if (!isMobile) {
    // 键盘：M 加备注，R 标记待返工
    await page.getByTestId('preview-stage').click();
    await page.keyboard.press('m');
    await page.getByRole('dialog').getByRole('textbox').fill('开头节奏太慢');
    await page.getByRole('dialog').getByRole('button', { name: '添加' }).click();
    await expect(page.getByRole('region', { name: '审片备注' })).toContainText('开头节奏太慢');
    await page.keyboard.press('r');
    await expect(page.getByTestId('preview-stage').getByText('待返工')).toBeVisible();
  } else {
    await page.getByRole('button', { name: '审片备注（M）' }).click();
    await page.getByRole('dialog').getByRole('textbox').fill('开头节奏太慢');
    await page.getByRole('dialog').getByRole('button', { name: '添加' }).click();
    await expect(page.getByRole('region', { name: '审片备注' })).toContainText('开头节奏太慢');
  }

  const panel = page.getByRole('region', { name: '配音与成片' });
  await expect(panel.getByText('模拟配音')).toBeVisible();
  await panel.getByRole('button', { name: '一键配音' }).click();
  await expect(panel.getByText('2/2 句已配音')).toBeVisible({ timeout: 20_000 });

  // 镜头都还没有画面：试算提示会跳过
  await panel.getByRole('button', { name: '渲染成片' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/个镜头没有画面|没有安装 ffmpeg/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: '开始渲染' })).toBeDisabled();
});

test('EXP-04 故事包：导出后在故事列表导入，得到一份新故事', async ({ page, isMobile }) => {
  test.skip(isMobile, '桌面上测一次即可');
  await register(page);
  const id = await seedStory(page);
  const zip = await page.request.get(`/api/stories/${id}/package`);
  expect(zip.ok()).toBeTruthy();
  await page.goto('/studio/stories');
  await page.getByLabel('选择故事包').setInputFiles({ name: '成片预览.weave.zip', mimeType: 'application/zip', buffer: await zip.body() });
  await expect(page).toHaveURL(/\/studio\/stories\/s_/);
  await expect(page).not.toHaveURL(new RegExp(id));
  await expect(page.getByText('已导入「成片预览」')).toBeVisible();
});
