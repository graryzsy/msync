import { homedir } from 'node:os';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lock } from 'proper-lockfile';
import open from 'open';
import { MSyncError } from '../core/models.js';

export function dataDirectory(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.MSYNC_DATA_DIR) return resolve(env.MSYNC_DATA_DIR);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'MSync');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'MSync');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'MSync');
}
export async function lockDataDirectory(directory: string, onCompromised?: (error: Error) => void): Promise<() => Promise<void>> {
  mkdirSync(directory, { recursive: true, mode: 0o700 }); const canonical = realpathSync(directory);
  try {
    return await lock(canonical, { lockfilePath: join(canonical, '.service.lock'), stale: 30_000, update: 10_000, retries: 0,
      ...(onCompromised ? { onCompromised } : {}) });
  } catch { throw new MSyncError('另一个后台正在使用此数据目录；请先关闭它。若上次异常退出，请等待 30 秒后重试'); }
}
export async function openBrowser(address: string): Promise<void> { await open(address, { wait: false }); }
