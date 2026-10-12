// STY-09 接续上一镜尾帧（界面）：整场接续开关、批量试算里提示接续、"等上一镜"标记和取消等待
import { expect, test } from '@playwright/test';

test('STY-09 整场接续：开关写进镜头设置，批量试算提示一镜接一镜，等待中的镜头可以取消', async ({ page, isMobile }) => {
  test.skip(isMobile, '桌面上测一次即可');
  const email = `chain-${Date.now()}@e2e.local`;
  expect((await page.request.post('/api/auth/register', { data: { email, password: 'password123', name: '接续' } })).ok()).toBeTruthy();
  const story = await (await page.request.post('/api/stories', { data: { title: '接续', logline: '' } })).json();
  const t = Date.now().toString(36);
  const shots = [1, 2, 3].map((n) => `s${n}_${t}`);
  const ops = [
    { op: 'create', entity: 'chapter', id: `ch_${t}`, sortKey: 'i', value: { title: '第一章' } },
    { op: 'create', entity: 'scene', id: `sc_${t}`, parentId: `ch_${t}`, sortKey: 'i', value: { title: '花园' } },
    ...shots.map((id, i) => ({ op: 'create', entity: 'shot', id, parentId: `sc_${t}`, sortKey: 'abc'[i], value: { shotSize: '中景', cameraMove: '固定', description: `第 ${i + 1} 段`, duration: 3 } })),
  ];
  expect((await page.request.post(`/api/stories/${story.id}/ops`, { data: { ops } })).ok()).toBeTruthy();

  await page.goto(`/studio/stories/${story.id}?tab=shots`);
  await page.getByRole('button', { name: '整场接续' }).click();
  await expect(page.getByRole('button', { name: '整场接续中' })).toBeVisible();
  await expect
    .poll(async () => (await (await page.request.get(`/api/stories/${story.id}`)).json()).data.chapters[0].scenes[0].shots.map((s: any) => s.firstFrame?.mode ?? 'keyframe'), { timeout: 10_000 })
    .toEqual(['keyframe', 'prev_last', 'prev_last']);

  // 批量出视频的试算：第 2、3 镜接续上一镜
  await page.getByRole('button', { name: '批量生成…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: '视频', exact: true }).click();
  await expect(dialog).toContainText('另有 2 个镜头接续上一镜尾帧');
  await expect(dialog).toContainText('最长一串 3 段');
  await dialog.getByRole('button', { name: '取消' }).first().click();

  // 单镜排队等上一镜：卡片上显示等待，可以取消
  expect((await page.request.post(`/api/stories/${story.id}/chains`, { data: { shotId: shots[2] } })).ok()).toBeTruthy();
  await page.reload();
  const waiting = page.getByTestId('chain-waiting');
  await expect(waiting).toHaveCount(1);
  await waiting.getByRole('button', { name: '取消等待' }).click();
  await expect(waiting).toHaveCount(0);
  expect(await (await page.request.get(`/api/stories/${story.id}/chains`)).json()).toEqual([]);
});
