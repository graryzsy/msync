import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { join } from 'node:path';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { StateStore } from '../core/store.js';
import { atomicWrite } from '../core/persistence.js';
import { MSyncError, errorMessage, itemSchema, kindSchema, platformSchema } from '../core/models.js';
import type { Mapping } from '../core/models.js';
import { AppController } from './controller.js';
import { CredentialVault } from './credentials.js';
import { allowedExternalURL, trustedRenderer } from './security.js';

app.setName('MSync');
const userDirectory = process.env.MSYNC_DATA_DIR ?? join(app.getPath('appData'), 'MSync');
mkdirSync(userDirectory, { recursive: true, mode: 0o700 }); app.setPath('userData', userDirectory);
const devURL = !app.isPackaged && process.env.MSYNC_DEV_URL === 'http://127.0.0.1:5173' ? process.env.MSYNC_DEV_URL : undefined;
const renderer = pathToFileURL(join(fileURLToPath(new URL('..', import.meta.url)), 'renderer/index.html')).href;
let window: BrowserWindow | null = null;
let controller: AppController | undefined;
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
    const directory = app.getPath('userData');
    const store = await StateStore.open(join(directory, 'collections.sqlite'));
    const vault = new CredentialVault(join(directory, 'credentials.enc'), safeStorage);
    const scriptPath = app.isPackaged ? join(process.resourcesPath, 'msync-resources/music-bridge.js') : join(app.getAppPath(), 'resources/music-bridge.js');
    const openURL = async (address: string): Promise<void> => { await shell.openExternal(allowedExternalURL(address).toString()); };
    controller = new AppController(directory, store, vault, scriptPath, openURL);
    if (!app.isPackaged && process.argv.includes('--msync-demo')) await controller.demoMode(true);

    function handle(name: string, schema: z.ZodTypeAny, work: (...args: any[]) => unknown): void {
      ipcMain.handle(`msync:${name}`, async (event, ...args: unknown[]) => {
        try {
          if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !trustedRenderer(event.senderFrame.url, renderer, devURL)) throw new MSyncError('拒绝非应用页面的请求');
          return { ok: true, value: await work(...schema.parse(args)) };
        } catch (error) { return { ok: false, error: error instanceof z.ZodError ? '输入内容无效，请检查后重试' : errorMessage(error) }; }
      });
    }
    const none = z.tuple([]), uuid = z.tuple([z.string().uuid()]);
    handle('getState', none, () => controller!.view());
    handle('saveSettings', z.tuple([z.object({ spotifyClientID: z.string().trim().max(128), appleMode: z.enum(['native', 'web', 'disabled']) })]), value => controller!.saveSettings(value));
    handle('connectSpotify', none, () => controller!.connectSpotify());
    handle('cancelLogin', none, () => controller!.cancelLogin());
    handle('disconnect', z.tuple([platformSchema]), platform => controller!.disconnect(platform));
    handle('startNeteaseLogin', none, () => controller!.startNeteaseLogin());
    handle('checkNeteaseLogin', z.tuple([z.string().min(1).max(256)]), key => controller!.checkNeteaseLogin(key));
    handle('scan', none, () => controller!.scan()); handle('apply', uuid, id => controller!.apply(id));
    handle('search', z.tuple([itemSchema, platformSchema]), (item, platform) => controller!.search(item, platform));
    handle('addMapping', z.tuple([z.object({ id: z.string().uuid(), kind: kindSchema, items: z.array(itemSchema).min(2).max(3), verified: z.literal(true), evidence: z.string().trim().min(1).max(8000) })]), (mapping: Mapping) => controller!.addMapping(mapping));
    handle('removeMapping', uuid, id => controller!.removeMapping(id));
    handle('recordApple', z.tuple([itemSchema, z.boolean()]), (item, saved) => controller!.recordApple(item, saved));
    handle('openExternal', z.tuple([z.string().max(4096)]), openURL);
    handle('demoMode', z.tuple([z.boolean()]), enabled => controller!.demoMode(enabled));
    handle('simulateDemoChange', z.tuple([platformSchema, z.boolean(), kindSchema]), (platform, saved, kind) => controller!.simulate(platform, saved, kind));
    handle('exportBackup', none, async () => {
      const selected = await dialog.showSaveDialog(window!, { defaultPath: 'msync-backup.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (selected.canceled || !selected.filePath) return false;
      atomicWrite(selected.filePath, JSON.stringify(controller!.store.load(), null, 2)); return true;
    });
    handle('importBackup', none, async () => {
      const selected = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: 'MSync JSON backup', extensions: ['json'] }] });
      if (selected.canceled || !selected.filePaths[0]) return controller!.view();
      const answer = await dialog.showMessageBox(window!, { type: 'question', buttons: ['取消', '导入备份'], defaultId: 0, cancelId: 0, message: '用备份中的对应关系和历史替换本机记录？', detail: '平台收藏与登录凭据保持原样。建议先导出当前记录。' });
      if (answer.response !== 1) return controller!.view();
      const bytes = readFileSync(selected.filePaths[0]); if (bytes.length > 64 * 1024 * 1024) throw new MSyncError('备份文件超过 64 MB');
      try { return await controller!.importBackup(JSON.parse(bytes.toString('utf8'))); }
      catch (error) { if (error instanceof MSyncError) throw error; throw new MSyncError('备份格式无效，当前记录保持原样'); }
    });
    handle('resetHistory', none, async () => {
      const answer = await dialog.showMessageBox(window!, { type: 'warning', buttons: ['取消', '清除本地历史'], defaultId: 0, cancelId: 0, message: '清除本机的对应关系与同步历史？', detail: '平台收藏、网页确认记录和登录凭据保持原样。建议先导出备份。' });
      return answer.response === 1 ? controller!.resetHistory() : controller!.view();
    });
    const createWindow = (): void => {
      window = new BrowserWindow({ width: 1280, height: 860, minWidth: 960, minHeight: 640, backgroundColor: '#111216', title: 'MSync', show: false,
        webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
      window.removeMenu();
      window.webContents.setWindowOpenHandler(({ url }) => { void openURL(url).catch(() => {}); return { action: 'deny' }; });
      window.webContents.on('will-navigate', (event, address) => { if (!trustedRenderer(address, renderer, devURL)) event.preventDefault(); });
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.once('ready-to-show', () => window?.show()); window.on('closed', () => { window = null; });
      if (devURL) void window.loadURL(devURL); else void window.loadURL(renderer);
    };
    createWindow();
    app.on('activate', () => { if (!window) createWindow(); else window.show(); });
  }).catch(error => {
    dialog.showErrorBox('MSync 无法启动', errorMessage(error)); app.quit();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => controller?.cancelLogin());
}
