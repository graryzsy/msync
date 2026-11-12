import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDirectory, lockDataDirectory } from '../src/main/runtime.js';

const source = new URL('../src/main/index.ts', import.meta.url).href;
const token = 'runtime-fixture-web-access-code-0000';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function launch(directory: string, port: string = '0') {
  let output = '';
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', `import(${JSON.stringify(source)})`], { cwd: process.cwd(), env: { ...process.env,
    MSYNC_DATA_DIR: directory, MSYNC_WEB_HOST: '127.0.0.1', MSYNC_WEB_PORT: port, MSYNC_WEB_TOKEN: token,
    MSYNC_NO_OPEN: '1', MSYNC_CREDENTIAL_STORE: 'memory', MSYNC_DEV_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', bytes => { output += String(bytes); }); child.stderr!.on('data', bytes => { output += String(bytes); });
  const completion = new Promise<number | null>(resolve => child.once('exit', resolve));
  return { child, completion, output: () => output, ready: async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const url = /MSync 网页：(http:\/\/127\.0\.0\.1:\d+)/u.exec(output)?.[1];
      if (url) return url;
      if (child.exitCode !== null) throw Error(output);
      await sleep(50);
    }
    throw Error('Node service did not become ready');
  } };
}
async function stop(child: ChildProcess, completion: Promise<number | null>) { if (child.exitCode === null) child.kill(); await completion; }

test('Node runtime uses the existing platform data directories and honors overrides', () => {
  const profile = join(tmpdir(), 'msync-home');
  assert.equal(dataDirectory('darwin', {}, profile), join(profile, 'Library', 'Application Support', 'MSync'));
  assert.equal(dataDirectory('win32', { APPDATA: join(profile, 'roaming') }, profile), join(profile, 'roaming', 'MSync'));
  assert.equal(dataDirectory('win32', {}, profile), join(profile, 'AppData', 'Roaming', 'MSync'));
  assert.equal(dataDirectory('linux', { XDG_CONFIG_HOME: join(profile, 'xdg') }, profile), join(profile, 'xdg', 'MSync'));
  assert.equal(dataDirectory('linux', {}, profile), join(profile, '.config', 'MSync'));
  assert.equal(dataDirectory('darwin', { MSYNC_DATA_DIR: profile }, '/unused'), profile);
});
test('the directory lock also excludes a different Node process and is reusable after release', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync lock ')), release = await lockDataDirectory(directory);
  try {
    const url = new URL('../src/main/runtime.ts', import.meta.url).href;
    const program = `import {lockDataDirectory} from ${JSON.stringify(url)}; try {const release=await lockDataDirectory(${JSON.stringify(directory)}); await release(); process.exit(0)} catch {process.exit(7)}`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(result.status, 7, result.stderr);
  } finally { await release(); }
  try { const again = await lockDataDirectory(directory); await again(); assert.equal(existsSync(join(directory, '.service.lock')), false); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});
test('Node startup preserves legacy files, rejects a second port on the same data, and releases its lock at shutdown', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync node startup ')), legacy = join(directory, 'credentials.enc');
  writeFileSync(legacy, 'legacy-private-ciphertext'); const first = launch(directory); let second: ReturnType<typeof launch> | undefined;
  try {
    const url = await first.ready(); assert.equal((await fetch(`${url}/health`)).status, 200);
    const headers = { 'X-MSync-Request': '1', 'Content-Type': 'application/json' };
    const response = await fetch(`${url}/api/session`, { method: 'POST', headers, body: JSON.stringify({ token }) });
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const view = await (await fetch(`${url}/api/state`, { headers: { ...headers, Cookie: cookie } })).json();
    assert.equal(view.value.credentialStorage, 'session'); assert.equal(view.value.connections.length, 3);
    assert.doesNotMatch(JSON.stringify(view), /legacy-private-ciphertext/);
    second = launch(directory); assert.equal(await second.completion, 1); assert.match(second.output(), /另一个后台/);
    assert.equal((await fetch(`${url}/health`)).status, 200); assert.equal(readFileSync(legacy, 'utf8'), 'legacy-private-ciphertext');
    await stop(first.child, first.completion);
    // Windows SIGTERM terminates the process directly; graceful signal cleanup is checked on POSIX.
    if (process.platform !== 'win32') {
      assert.equal(existsSync(join(directory, '.service.lock')), false);
      const restarted = launch(directory); try { await restarted.ready(); } finally { await stop(restarted.child, restarted.completion); }
    }
  } finally {
    await stop(first.child, first.completion); if (second) await stop(second.child, second.completion);
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
