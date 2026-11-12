import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url), directory = mkdtempSync(join(tmpdir(), 'msync-web-e2e-'));
const child = spawn(process.env.MSYNC_ELECTRON_EXECUTABLE ?? require('electron'), [
  ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', '--ozone-platform=headless'] : []),
  ...(process.env.MSYNC_ELECTRON_EXECUTABLE ? [] : [resolve('.')]), '--msync-no-open', '--msync-no-tray'
], { stdio: 'inherit', env: { ...process.env, MSYNC_DATA_DIR: directory, MSYNC_WEB_HOST: '127.0.0.1', MSYNC_WEB_PORT: '19429',
  MSYNC_WEB_TOKEN: 'web-e2e-fixture-access-code-00000000', MSYNC_NO_OPEN: '1', XDG_CACHE_HOME: join(directory, 'cache') } });
const stop = () => { child.kill(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); process.exitCode = code ?? 0; });
