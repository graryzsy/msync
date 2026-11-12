import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../core/store.js';
import { errorMessage, MSyncError } from '../core/models.js';
import { AppController } from './controller.js';
import { CredentialVault } from './credentials.js';
import { createCredentialCipher, credentialFilename } from './credential-cipher.js';
import { dataDirectory, lockDataDirectory, openBrowser } from './runtime.js';
import { allowedExternalURL } from './security.js';
import { startWebServer } from '../server/web.js';

let background: Awaited<ReturnType<typeof startWebServer>> | undefined;
let controller: AppController | undefined, store: StateStore | undefined, vault: CredentialVault | undefined;
let release: (() => Promise<void>) | undefined, stopping = false;
async function stop(code: number): Promise<void> {
  if (stopping) return; stopping = true; controller?.cancelLogin(); vault?.close();
  try { await background?.close(); } catch { /* Continue releasing the data directory on shutdown. */ }
  try { store?.close(); } finally { try { await release?.(); } finally { process.exit(code); } }
}
function fail(error: unknown): void { console.error(errorMessage(error)); void stop(1); }
process.once('SIGINT', () => { void stop(0); }); process.once('SIGTERM', () => { void stop(0); });

async function main(): Promise<void> {
  const directory = dataDirectory(); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const port = Number(process.env.MSYNC_WEB_PORT ?? '19427');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new MSyncError('MSYNC_WEB_PORT 必须是有效端口号');
  const credentialStore = process.env.MSYNC_CREDENTIAL_STORE ?? 'system';
  if (credentialStore !== 'system' && credentialStore !== 'memory') throw new MSyncError('MSYNC_CREDENTIAL_STORE 只支持 system 或 memory');
  release = await lockDataDirectory(directory, () => fail(new MSyncError('后台失去了数据目录锁，已停止运行以保留原数据')));
  if (stopping) return;
  const cipher = await createCredentialCipher(directory, { key: process.env.MSYNC_CREDENTIAL_KEY, store: credentialStore });
  if (stopping) return;
  vault = new CredentialVault(join(directory, credentialFilename), cipher);
  if (existsSync(join(directory, 'credentials.enc')) && !existsSync(join(directory, credentialFilename))) {
    console.log('旧版登录凭据已保留；请在网页重新连接 Spotify 和网易云，收藏与同步历史继续沿用。');
  }
  if (vault.mode === 'session') console.log('当前无法加密保存登录凭据，登录仅在本次后台运行中保留。');
  store = await StateStore.open(join(directory, 'collections.sqlite'));
  controller = new AppController(directory, store, vault, fileURLToPath(new URL('../../resources/music-bridge.js', import.meta.url)), async address => {
    await openBrowser(allowedExternalURL(address).toString());
  });
  if (process.argv.includes('--demo')) await controller.demoMode(true);
  const devURL = process.env.MSYNC_DEV_URL === 'http://127.0.0.1:5173' ? process.env.MSYNC_DEV_URL : undefined;
  const accessToken = process.env.MSYNC_WEB_TOKEN ?? randomBytes(32).toString('base64url');
  background = await startWebServer({ controller, accessToken, port, host: process.env.MSYNC_WEB_HOST ?? '127.0.0.1', devURL,
    rendererDirectory: fileURLToPath(new URL('../renderer', import.meta.url)) });
  if (stopping) return;
  console.log(`MSync 网页：${devURL ?? background.url}`); console.log(`网页访问口令：${accessToken}`);
  console.log(`数据目录：${directory}`); console.log('关闭网页后后台继续运行；在此终端按 Ctrl+C 退出。');
  if (process.env.MSYNC_NO_OPEN !== '1') {
    try { await openBrowser(background.browserURL); } catch { console.log('无法自动打开浏览器，请手动访问上面的网页地址。'); }
  }
}
main().catch(fail);
