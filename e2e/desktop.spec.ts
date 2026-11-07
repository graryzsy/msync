import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SpotifyScanIssue } from '../src/shared/spotify-diagnostics.js';

test('desktop demo, strict edition review, deletion propagation and isolated credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync-electron-test-'));
  const extra = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', '--ozone-platform=headless'] : [];
  const application = await electron.launch({
    ...(process.env.MSYNC_ELECTRON_EXECUTABLE ? { executablePath: process.env.MSYNC_ELECTRON_EXECUTABLE } : {}),
    args: [...extra, ...(process.env.MSYNC_ELECTRON_EXECUTABLE ? [] : [resolve('.')])],
    env: { ...process.env, MSYNC_DATA_DIR: directory, XDG_CACHE_HOME: join(directory, 'cache') }, timeout: 30_000
  });
  try {
    const page = await application.firstWindow(), errors: string[] = [];
    await page.setViewportSize({ width: 1440, height: 1000 });
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '收藏好音乐，不必重复收藏。' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '从连接你的音乐开始' })).toBeVisible();
    await page.getByRole('button', { name: '体验离线演示' }).click();
    await expect(page.locator('.demo-banner')).toContainText('离线演示');
    await expect(page.locator('.music-row')).toHaveCount(6);
    await page.locator('.music-row').first().click();
    await expect(page.locator('.detail-panel h2')).toHaveText('Late Summer');
    await page.locator('.content').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: 'artifacts/ui/library.png', fullPage: true });
    await page.getByRole('button', { name: '查找对应版本' }).click();
    const search = page.getByRole('dialog', { name: '查找对应版本' });
    await search.getByRole('button', { name: '查找', exact: true }).click();
    await expect(search.locator('.candidate')).toHaveCount(2);
    await expect(search.locator('.candidate').last()).toContainText('Greatest Hits');
    await expect(search.locator('.candidate').last().getByRole('button', { name: '核实对应关系' })).toBeDisabled();
    await search.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '同步预览' }).click();
    await page.getByRole('button', { name: '模拟取消收藏' }).click();
    await expect(page.locator('.operation')).toHaveCount(2);
    await expect(page.locator('.operation-list')).toContainText('取消收藏');
    await page.screenshot({ path: 'artifacts/ui/deletion-preview.png', fullPage: true });
    await page.getByRole('button', { name: '执行 2 项同步' }).click();
    await page.getByRole('dialog', { name: '执行本次同步？' }).getByRole('button', { name: '确认执行' }).click();
    await expect(page.locator('.statusbar')).toContainText('已完成 2 项操作');
    await page.getByRole('button', { name: '重新扫描' }).click();
    await expect(page.getByRole('heading', { name: '目前没有需要修改的收藏' })).toBeVisible();
    const runtime = await page.evaluate(async () => {
      const state = await window.msync!.getState();
      return { demo: state.demo, pending: state.state.outstanding.length, credentialExposed: JSON.stringify(state).includes('accessToken'), nodeAvailable: 'require' in window };
    });
    expect(runtime).toEqual({ demo: true, pending: 0, credentialExposed: false, nodeAvailable: false });
    await page.getByRole('button', { name: '退出演示' }).click();
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '音乐收藏' }).click();
    await expect(page.getByRole('heading', { name: '从连接你的音乐开始' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('QR login shows confirmation and failure inside the dialog and discards expired QR images', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync-qr-test-'));
  const extra = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', '--ozone-platform=headless'] : [];
  const application = await electron.launch({
    ...(process.env.MSYNC_ELECTRON_EXECUTABLE ? { executablePath: process.env.MSYNC_ELECTRON_EXECUTABLE } : {}),
    args: [...extra, ...(process.env.MSYNC_ELECTRON_EXECUTABLE ? [] : [resolve('.')])],
    env: { ...process.env, MSYNC_DATA_DIR: directory, XDG_CACHE_HOME: join(directory, 'cache') }, timeout: 30_000
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '收藏好音乐，不必重复收藏。' })).toBeVisible();
    const view = await page.evaluate(() => window.msync!.getState());
    // Replace only the two login handlers in this isolated test process.
    // Every account response is a fixture; the test makes no NetEase requests.
    await application.evaluate(({ ipcMain }, state) => {
      ipcMain.removeHandler('msync:startNeteaseLogin'); ipcMain.removeHandler('msync:checkNeteaseLogin');
      ipcMain.handle('msync:startNeteaseLogin', () => ({ ok: true, value: {
        key: 'offline-test-key', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/jNQAAAAASUVORK5CYII='
      } }));
      const codes = [802, 'rejected', 801, 800, 803];
      ipcMain.handle('msync:checkNeteaseLogin', () => {
        const code = codes.shift();
        if (code === 'rejected') return { ok: false, error: '网易云未接受本次登录请求（代码 405）。若手机提示“设备环境异常”，请暂停扫码。' };
        return { ok: true, value: { code, view: code === 803 ? {
          ...state, message: '网易云已连接。', connections: state.connections.map(connection => connection.platform === 'netease' ? { ...connection, connected: true } : connection)
        } : state } };
      });
    }, view);
    await page.getByRole('button', { name: '账户与设置' }).click();
    await page.getByRole('button', { name: '生成登录二维码' }).click();
    const qr = page.getByRole('dialog', { name: '使用网易云音乐 App 扫码' });
    await expect(qr.getByText('扫码后在手机上确认，再检查登录状态。')).toBeVisible();
    await qr.getByRole('button', { name: '检查登录状态' }).click();
    await expect(qr.getByRole('status')).toHaveText('请在手机上确认登录。');
    await qr.getByRole('button', { name: '检查登录状态' }).click();
    await expect(qr.getByRole('alert')).toContainText('代码 405');
    await expect(qr.getByRole('alert')).toContainText('设备环境异常');
    await qr.getByRole('button', { name: '检查登录状态' }).click();
    await expect(qr.getByRole('status')).toHaveText('等待扫码。');
    await expect(qr.getByRole('alert')).toHaveCount(0);
    await qr.getByRole('button', { name: '检查登录状态' }).click();
    await expect(qr).not.toBeVisible();
    await expect(page.getByText('二维码已过期，请重新生成。')).toBeVisible();
    await page.getByRole('button', { name: '生成登录二维码' }).click();
    await expect(qr.getByRole('status')).toHaveText('扫码后在手机上确认，再检查登录状态。');
    await qr.getByRole('button', { name: '检查登录状态' }).click();
    await expect(qr).not.toBeVisible();
    await expect(page.getByRole('button', { name: '重新扫码登录' })).toBeVisible();
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('scan limitations and partial metadata are explained separately from request failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync-scan-notes-test-'));
  const extra = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', '--ozone-platform=headless'] : [];
  const application = await electron.launch({
    ...(process.env.MSYNC_ELECTRON_EXECUTABLE ? { executablePath: process.env.MSYNC_ELECTRON_EXECUTABLE } : {}),
    args: [...extra, ...(process.env.MSYNC_ELECTRON_EXECUTABLE ? [] : [resolve('.')])],
    env: { ...process.env, MSYNC_DATA_DIR: directory, XDG_CACHE_HOME: join(directory, 'cache') }, timeout: 30_000
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '收藏好音乐，不必重复收藏。' })).toBeVisible();
    const state = await page.evaluate(() => window.msync!.getState());
    await application.evaluate(({ ipcMain }, view) => {
      ipcMain.removeHandler('msync:scan');
      ipcMain.handle('msync:scan', () => ({ ok: true, value: { ...view, plan: {
        id: '11111111-1111-4111-8111-111111111111', baseRevision: view.state.revision, createdAt: new Date().toISOString(),
        observations: [], operations: [], desired: {},
        notes: ['Apple Music · 收藏的艺人：本机 Music.app 模式没有完整艺人喜爱接口；请使用网页确认模式。', 'Spotify：有 1 项缺少可用元数据，未读到的条目状态保持未知。'],
        issues: [{ id: '22222222-2222-4222-8222-222222222222', message: '网易云登录已过期（接口 login_status），请重新连接账户' }]
      }, message: '扫描完成：0 项待同步，1 项待处理，2 条扫描说明。' } }));
    }, state);
    await page.getByRole('button', { name: '扫描收藏', exact: true }).click();
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '同步预览' }).click();
    const notes = page.locator('section').filter({ has: page.getByRole('heading', { name: '扫描说明', exact: true }) });
    const failures = page.locator('section').filter({ has: page.getByRole('heading', { name: '待处理项目', exact: true }) });
    await expect(notes).toContainText('网页确认模式'); await expect(notes).toContainText('状态保持未知');
    await expect(failures).toContainText('login_status'); await expect(failures).not.toContainText('Apple Music');
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('all Spotify diagnostic rows can be inspected and exported from the desktop preview', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync-spotify-diagnostics-test-'));
  const extra = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', '--ozone-platform=headless'] : [];
  const application = await electron.launch({
    ...(process.env.MSYNC_ELECTRON_EXECUTABLE ? { executablePath: process.env.MSYNC_ELECTRON_EXECUTABLE } : {}),
    args: [...extra, ...(process.env.MSYNC_ELECTRON_EXECUTABLE ? [] : [resolve('.')])],
    env: { ...process.env, MSYNC_DATA_DIR: directory, XDG_CACHE_HOME: join(directory, 'cache') }, timeout: 30_000
  });
  try {
    const page = await application.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '收藏好音乐，不必重复收藏。' })).toBeVisible();
    const view = await page.evaluate(() => window.msync!.getState());
    const issues: SpotifyScanIssue[] = Array.from({ length: 15 }, (_, index) => ({ kind: 'track', position: 711 + index, field: 'name', problem: '文本为空，接口未提供可用名称或标识',
      url: `https://open.spotify.com/track/missing${index}`, source: { id: `missing${index}`, recordState: 'object', nameState: 'empty', artists: ['Fixture Artist'], isPlayable: false } }));
    // Only fixtures in an isolated process; no account or external music requests.
    await application.evaluate(({ ipcMain }, input) => {
      const state = { ...input.view, spotifyScanIssues: input.issues };
      for (const name of ['scan', 'inspectSpotifyIssues', 'exportSpotifyDiagnostics']) ipcMain.removeHandler(`msync:${name}`);
      ipcMain.handle('msync:scan', () => ({ ok: true, value: state }));
      ipcMain.handle('msync:inspectSpotifyIssues', () => ({ ok: true, value: { ...state, spotifyScanIssues: state.spotifyScanIssues.map(issue => ({ ...issue,
        inspection: { checkedAt: new Date().toISOString(), finding: 'empty_metadata', explanation: '单项详情也未提供可用名称，无法确认发行版本。' }
      })) } }));
      ipcMain.handle('msync:exportSpotifyDiagnostics', () => ({ ok: true, value: true }));
    }, { view, issues });
    await page.getByRole('button', { name: '扫描收藏', exact: true }).click();
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '同步预览' }).click();
    const diagnostics = page.getByRole('region', { name: 'Spotify 异常条目', exact: true });
    await expect(diagnostics.getByRole('heading', { name: 'Spotify 异常条目（15）' })).toBeVisible();
    await expect(diagnostics.locator('.spotify-diagnostic-row')).toHaveCount(15);
    await expect(diagnostics.locator('.spotify-diagnostic-row').last()).toContainText('missing14');
    await diagnostics.getByRole('button', { name: '检查异常条目详情' }).click();
    await expect(diagnostics.locator('.diagnostic-finding')).toHaveCount(15);
    await expect(diagnostics.locator('.diagnostic-finding').first()).toContainText('单项详情也未提供可用名称');
    await diagnostics.locator('.spotify-diagnostic-row').first().getByText('查看诊断字段', { exact: true }).click();
    await expect(diagnostics.locator('pre').first()).toContainText('"isPlayable": false');
    await diagnostics.getByRole('button', { name: '导出 Spotify 诊断' }).click();
    await expect(page.getByRole('status')).toHaveText('Spotify 诊断已导出，不包含登录凭据。');
    await diagnostics.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/ui/spotify-diagnostics.png' });
    expect(errors).toEqual([]);
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
