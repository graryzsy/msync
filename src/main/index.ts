import { app, clipboard, dialog, Menu, nativeImage, safeStorage, shell, Tray } from 'electron';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../core/store.js';
import { errorMessage, MSyncError } from '../core/models.js';
import { AppController } from './controller.js';
import { CredentialVault } from './credentials.js';
import { allowedExternalURL } from './security.js';
import { startWebServer } from '../server/web.js';

// Keep the original runtime and user directory for safeStorage, loopback OAuth and Music.app.
// All application pages are served over HTTP and opened in the user's browser.
app.setName('MSync');
const directory = process.env.MSYNC_DATA_DIR ?? join(app.getPath('appData'), 'MSync');
mkdirSync(directory, { recursive: true, mode: 0o700 }); app.setPath('userData', directory);
let background: Awaited<ReturnType<typeof startWebServer>> | undefined;
let controller: AppController | undefined, store: StateStore | undefined, tray: Tray | undefined;
let quitting = false;
const openBrowser = async (): Promise<void> => { if (background) await shell.openExternal(background.browserURL); };
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { void openBrowser().catch(() => {}); });
  app.on('activate', () => { void openBrowser().catch(() => {}); });
  process.once('SIGINT', () => app.quit()); process.once('SIGTERM', () => app.quit());
  app.whenReady().then(async () => {
    const port = Number(process.env.MSYNC_WEB_PORT ?? '19427');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new MSyncError('MSYNC_WEB_PORT 必须是有效端口号');
    const accessToken = process.env.MSYNC_WEB_TOKEN ?? randomBytes(32).toString('base64url');
    const devURL = !app.isPackaged && process.env.MSYNC_DEV_URL === 'http://127.0.0.1:5173' ? process.env.MSYNC_DEV_URL : undefined;
    const resource = (name: string) => app.isPackaged ? join(process.resourcesPath, 'msync-resources', name) : join(app.getAppPath(), 'resources', name);
    store = await StateStore.open(join(directory, 'collections.sqlite'));
    const vault = new CredentialVault(join(directory, 'credentials.enc'), safeStorage);
    controller = new AppController(directory, store, vault, resource('music-bridge.js'), async address => { await shell.openExternal(allowedExternalURL(address).toString()); });
    if (!app.isPackaged && process.argv.includes('--msync-demo')) await controller.demoMode(true);
    background = await startWebServer({ controller, accessToken, port, host: process.env.MSYNC_WEB_HOST ?? '127.0.0.1', devURL,
      rendererDirectory: join(fileURLToPath(new URL('..', import.meta.url)), 'renderer') });
    console.log(`MSync 网页：${devURL ?? background.url}`);
    console.log(`网页访问口令：${accessToken}`);
    console.log('关闭浏览器后后台继续运行；可通过托盘菜单或终端 Ctrl+C 退出。');
    if (!process.argv.includes('--msync-no-tray')) {
      const items = [
        { label: '打开 MSync 网页', click: () => { void openBrowser().catch(() => {}); } },
        { label: '复制网页访问链接', click: () => { if (background) clipboard.writeText(background.browserURL); } },
        { type: 'separator' as const }, { label: '退出后台', role: 'quit' as const }
      ];
      const menu = Menu.buildFromTemplate(items);
      if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'MSync', submenu: items }]));
      try {
        const image = nativeImage.createFromPath(resource('tray-icon.png')).resize({ width: 20, height: 20 });
        if (process.platform === 'darwin') image.setTemplateImage(true);
        tray = new Tray(image); tray.setToolTip('MSync · 音乐收藏同步'); tray.setContextMenu(menu);
        tray.on('double-click', () => { void openBrowser().catch(() => {}); });
      } catch { console.log('系统托盘不可用，请通过终端管理后台。'); }
    }
    if (process.env.MSYNC_NO_OPEN !== '1' && !process.argv.includes('--msync-no-open')) {
      try { await openBrowser(); } catch { console.log('无法自动打开浏览器，请手动访问上面的网页地址。'); }
    }
  }).catch(error => { const message = errorMessage(error); console.error(message); dialog.showErrorBox('MSync 无法启动', message); app.exit(1); });
  app.on('before-quit', event => {
    if (quitting) return; event.preventDefault(); quitting = true; controller?.cancelLogin(); tray?.destroy();
    void (background?.close() ?? Promise.resolve()).finally(() => { store?.close(); app.quit(); });
  });
}
