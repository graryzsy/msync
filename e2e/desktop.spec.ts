import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
