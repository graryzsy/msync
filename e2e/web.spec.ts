import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { AppView, WebTask } from '../src/shared/api.js';
import type { SpotifyScanIssue } from '../src/shared/spotify-diagnostics.js';

const headers = { 'X-MSync-Request': '1' };
async function state(page: Page): Promise<AppView> { return (await (await page.request.get('/api/state', { headers })).json()).value; }
async function action(page: Page, name: string, ...args: unknown[]): Promise<unknown> {
  const response = await page.request.post(`/api/actions/${name}`, { headers, data: { args } }); expect(response.status()).toBe(202);
  const { id } = (await response.json()).value;
  for (;;) {
    const task: WebTask = (await (await page.request.get(`/api/tasks/${id}`, { headers })).json()).value;
    if (task.state === 'failed') throw Error(task.error);
    if (task.state === 'succeeded') return task.value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function mockAction(page: Page, name: string, result: () => { value?: unknown; error?: string }) {
  let sequence = 0;
  await page.route(`**/api/actions/${name}`, async route => {
    const id = `fixture-${name}-${sequence++}`, output = result();
    await page.route(`**/api/tasks/${id}`, next => next.fulfill({ json: { ok: true, value: { id, label: name, state: output.error ? 'failed' : 'succeeded', ...output } } }));
    await route.fulfill({ status: 202, json: { ok: true, value: { id } } });
  });
}

test.beforeEach(async ({ page }) => {
  const login = await page.request.post('/api/session', { headers, data: { token: 'web-e2e-fixture-access-code-00000000' } }); expect(login.status()).toBe(200);
  await action(page, 'demoMode', false); await action(page, 'resetHistory');
  await page.goto('/'); await expect(page.getByRole('heading', { name: '收藏好音乐，不必重复收藏。' })).toBeVisible();
});

test('browser demo preserves strict release review, deletion propagation and credential isolation', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByRole('heading', { name: '从连接你的音乐开始' })).toBeVisible();
  await page.getByRole('button', { name: '体验离线演示' }).click();
  await expect(page.locator('.demo-banner')).toContainText('离线演示'); await expect(page.locator('.music-row')).toHaveCount(6);
  await page.locator('.music-row').first().click(); await expect(page.locator('.detail-panel h2')).toHaveText('Late Summer');
  await page.screenshot({ path: 'artifacts/ui/web-library.png' });
  await page.getByRole('button', { name: '查找对应版本' }).click();
  const search = page.getByRole('dialog', { name: '查找对应版本' });
  await search.getByRole('button', { name: '查找', exact: true }).click(); await expect(search.locator('.candidate')).toHaveCount(2);
  await expect(search.locator('.candidate').last()).toContainText('Greatest Hits');
  await expect(search.locator('.candidate').last().getByRole('button', { name: '核实对应关系' })).toBeDisabled();
  await search.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '同步预览' }).click();
  await page.getByRole('button', { name: '模拟取消收藏' }).click(); await expect(page.locator('.operation')).toHaveCount(2);
  await expect(page.locator('.operation-list')).toContainText('取消收藏');
  await page.screenshot({ path: 'artifacts/ui/web-deletion-preview.png' });
  await page.getByRole('button', { name: '执行 2 项同步' }).click();
  await page.getByRole('dialog', { name: '执行本次同步？' }).getByRole('button', { name: '确认执行' }).click();
  await expect(page.locator('.statusbar')).toContainText('已完成 2 项操作');
  await page.getByRole('button', { name: '重新扫描' }).click(); await expect(page.getByRole('heading', { name: '目前没有需要修改的收藏' })).toBeVisible();
  await page.reload(); await expect(page.getByRole('heading', { name: '目前没有需要修改的收藏' })).toBeVisible();
  const view = await state(page); expect(view.demo).toBe(true); expect(view.state.outstanding).toHaveLength(0);
  expect(JSON.stringify(view)).not.toContain('accessToken');
  expect(await page.evaluate(() => ({ node: 'require' in window, bridge: 'msync' in window }))).toEqual({ node: false, bridge: false });
  await page.getByRole('button', { name: '退出演示' }).click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '音乐收藏' }).click();
  await expect(page.getByRole('heading', { name: '从连接你的音乐开始' })).toBeVisible(); expect(errors).toEqual([]);
});

test('web access gate accepts a code, clears bootstrap fragments and logs out independently of music accounts', async ({ page }) => {
  await page.getByRole('button', { name: '账户与设置', exact: true }).click();
  await page.getByRole('button', { name: '退出网页访问', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'MSync 网页访问' })).toBeVisible();
  await page.getByLabel('网页访问口令', { exact: true }).fill('wrong-code'); await page.getByRole('button', { name: '打开工作空间' }).click();
  await expect(page.getByRole('alert')).toContainText('口令不正确');
  await page.goto('/#msync-access=web-e2e-fixture-access-code-00000000');
  await expect(page.getByRole('heading', { name: '收藏好音乐，不必重复收藏。' })).toBeVisible(); expect(page.url()).not.toContain('msync-access');
  const cookie = (await page.context().cookies()).find(value => value.name === 'msync_web_session'); expect(cookie?.httpOnly).toBe(true); expect(cookie?.sameSite).toBe('Strict');
});

test('backup downloads and uploads use browser files and keep destructive confirmations', async ({ page }) => {
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: '导出备份', exact: true }).click();
  const download = await downloadPromise; expect(download.suggestedFilename()).toBe('msync-backup.json');
  const bytes = await readFile((await download.path())!); const backup = JSON.parse(bytes.toString()); expect(backup.mappings).toEqual([]); expect(backup.revision).toBeGreaterThan(0);
  await page.getByRole('button', { name: '账户与设置', exact: true }).click();
  const chooserPromise = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '导入备份', exact: true }).click();
  const chooser = await chooserPromise;
  page.once('dialog', dialog => { expect(dialog.message()).toContain('替换后台记录'); void dialog.accept(); });
  await chooser.setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: bytes });
  await expect(page.locator('.statusbar')).toContainText('已导入对应关系和历史');
  const before = (await state(page)).state.revision;
  page.once('dialog', dialog => { expect(dialog.message()).toContain('清除后台'); void dialog.dismiss(); });
  await page.getByRole('button', { name: '重新建立基线', exact: true }).click(); expect((await state(page)).state.revision).toBe(before);
});

test('QR login keeps confirmations, expiry and network errors inside the browser dialog', async ({ page }) => {
  const view = await state(page), codes: (number | 'rejected')[] = [802, 'rejected', 801, 800, 803];
  await mockAction(page, 'startNeteaseLogin', () => ({ value: { key: 'fixture-key', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/jNQAAAAASUVORK5CYII=' } }));
  await mockAction(page, 'checkNeteaseLogin', () => {
    const code = codes.shift();
    return code === 'rejected' ? { error: '网易云未接受本次登录请求（代码 405）。若手机提示“设备环境异常”，请暂停扫码。' }
      : { value: { code, view: code === 803 ? { ...view, connections: view.connections.map(connection => connection.platform === 'netease' ? { ...connection, connected: true } : connection) } : view } };
  });
  await page.getByRole('button', { name: '账户与设置', exact: true }).click(); await page.getByRole('button', { name: '生成登录二维码' }).click();
  const qr = page.getByRole('dialog', { name: '使用网易云音乐 App 扫码' });
  await qr.getByRole('button', { name: '检查登录状态' }).click(); await expect(qr.getByRole('status')).toHaveText('请在手机上确认登录。');
  await qr.getByRole('button', { name: '检查登录状态' }).click(); await expect(qr.getByRole('alert')).toContainText('代码 405');
  await qr.getByRole('button', { name: '检查登录状态' }).click(); await expect(qr.getByRole('status')).toHaveText('等待扫码。'); await expect(qr.getByRole('alert')).toHaveCount(0);
  await qr.getByRole('button', { name: '检查登录状态' }).click(); await expect(qr).not.toBeVisible();
  await expect(page.getByText('二维码已过期，请重新生成。')).toBeVisible();
  await page.getByRole('button', { name: '生成登录二维码' }).click(); await qr.getByRole('button', { name: '检查登录状态' }).click(); await expect(qr).not.toBeVisible();
  await expect(page.getByRole('button', { name: '重新扫码登录' })).toBeVisible();
});

test('all Spotify diagnostic rows can be inspected and downloaded in a browser', async ({ page }) => {
  const view = await state(page);
  const issues: SpotifyScanIssue[] = Array.from({ length: 15 }, (_, index) => ({ kind: 'track', position: 711 + index, field: 'name', problem: '文本为空，接口未提供可用名称或标识',
    url: `https://open.spotify.com/track/missing${index}`, source: { id: `missing${index}`, recordState: 'object', nameState: 'empty', artists: ['Fixture Artist'], isPlayable: false } }));
  await mockAction(page, 'scan', () => ({ value: { ...view, spotifyScanIssues: issues } }));
  const inspected = issues.map(issue => ({ ...issue, inspection: { checkedAt: new Date().toISOString(), finding: 'empty_metadata', explanation: '单项详情也未提供可用名称，无法确认发行版本。' } }));
  await mockAction(page, 'inspectSpotifyIssues', () => ({ value: { ...view, spotifyScanIssues: inspected } }));
  await page.route('**/api/downloads/spotify-diagnostics', route => route.fulfill({ json: { format: 'msync-spotify-diagnostics', version: 1, issues: inspected } }));
  await page.getByRole('button', { name: '扫描收藏', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '同步预览' }).click();
  const diagnostics = page.getByRole('region', { name: 'Spotify 异常条目', exact: true });
  await expect(diagnostics.locator('.spotify-diagnostic-row')).toHaveCount(15); await expect(diagnostics.locator('.spotify-diagnostic-row').last()).toContainText('missing14');
  await diagnostics.getByRole('button', { name: '检查异常条目详情' }).click(); await expect(diagnostics.locator('.diagnostic-finding')).toHaveCount(15);
  const downloadPromise = page.waitForEvent('download'); await diagnostics.getByRole('button', { name: '导出 Spotify 诊断' }).click();
  const download = await downloadPromise; expect(download.suggestedFilename()).toBe('msync-spotify-diagnostics.json');
  expect(JSON.parse(await readFile((await download.path())!, 'utf8')).issues).toHaveLength(15);
  await diagnostics.scrollIntoViewIfNeeded(); await page.screenshot({ path: 'artifacts/ui/web-spotify-diagnostics.png' });
});

test('scan limitations stay separate from request failures in the web preview', async ({ page }) => {
  const view = await state(page);
  await mockAction(page, 'scan', () => ({ value: { ...view, plan: {
    id: '11111111-1111-4111-8111-111111111111', baseRevision: view.state.revision, createdAt: new Date().toISOString(),
    observations: [], operations: [], desired: {},
    notes: ['Apple Music · 收藏的艺人：本机 Music.app 模式没有完整艺人喜爱接口；请使用网页确认模式。', 'Spotify：有 1 项缺少可用元数据，未读到的条目状态保持未知。'],
    issues: [{ id: '22222222-2222-4222-8222-222222222222', message: '网易云登录已过期（接口 login_status），请重新连接账户' }]
  } } }));
  await page.getByRole('button', { name: '扫描收藏', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '同步预览' }).click();
  const notes = page.locator('section').filter({ has: page.getByRole('heading', { name: '扫描说明', exact: true }) });
  const failures = page.locator('section').filter({ has: page.getByRole('heading', { name: '待处理项目', exact: true }) });
  await expect(notes).toContainText('网页确认模式'); await expect(notes).toContainText('状态保持未知');
  await expect(failures).toContainText('login_status'); await expect(failures).not.toContainText('Apple Music');
});

test('a refreshed browser recovers the running-task indicator and releases controls when it completes', async ({ page }) => {
  let running = true;
  await page.route('**/api/activity', route => route.fulfill({ json: { ok: true, value: { id: 'fixture-running-task', label: '扫描收藏', state: running ? 'running' : 'succeeded', startedAt: new Date().toISOString() } } }));
  await page.reload(); await expect(page.locator('.statusbar')).toContainText('扫描收藏，请稍候');
  await expect(page.getByRole('button', { name: '扫描收藏', exact: true })).toBeDisabled();
  await page.reload(); await expect(page.locator('.statusbar')).toContainText('扫描收藏，请稍候');
  running = false; await expect(page.getByRole('button', { name: '扫描收藏', exact: true })).toBeEnabled();
});

test('narrow browser layouts keep account settings and collection navigation accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '扫描收藏', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '体验离线演示' }).click(); await page.locator('.music-row').first().click();
  await page.getByRole('button', { name: '查找对应版本' }).click();
  const search = page.getByRole('dialog', { name: '查找对应版本' }); await expect(search).toBeVisible();
  await search.getByRole('button', { name: '关闭', exact: true }).click(); await page.getByRole('button', { name: '退出演示' }).click();
  await page.getByRole('button', { name: '账户与设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '网页访问', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/ui/web-mobile-settings.png', fullPage: true });
});
