import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'msync-web-e2e-'));
const child = spawn(process.execPath, [process.env.MSYNC_NODE_ENTRY ?? resolve('dist/main/index.js')], {
  cwd: directory, stdio: 'inherit', env: { ...process.env, MSYNC_DATA_DIR: directory, MSYNC_WEB_HOST: '127.0.0.1', MSYNC_WEB_PORT: '19429',
    MSYNC_WEB_TOKEN: 'web-e2e-fixture-access-code-00000000', MSYNC_NO_OPEN: '1', MSYNC_CREDENTIAL_STORE: 'memory', MSYNC_DEV_URL: '' }
});
const stop = () => { child.kill(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
let finished = false;
function finish(code) { if (finished) return; finished = true; rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); process.exitCode = code ?? 1; }
child.once('error', error => { console.error(error.message); finish(1); }); child.once('exit', finish);
