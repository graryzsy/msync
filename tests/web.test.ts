import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppController } from '../src/main/controller.js';
import { CredentialVault } from '../src/main/credentials.js';
import { StateStore } from '../src/core/store.js';
import { MSyncError } from '../src/core/models.js';
import { startWebServer, type WebServerOptions } from '../src/server/web.js';
import type { WebTask } from '../src/shared/api.js';

const token = 'web-fixture-access-code-000000000000';
async function setup(options: Pick<WebServerOptions, 'host' | 'devURL'> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'msync web ')), renderer = join(directory, 'renderer');
  mkdirSync(join(renderer, 'assets'), { recursive: true });
  writeFileSync(join(renderer, 'index.html'), '<!doctype html><title>MSync fixture</title>');
  writeFileSync(join(renderer, 'assets', 'app.js'), 'console.log("MSync")');
  writeFileSync(join(directory, 'credentials.enc'), 'must-not-be-served');
  const store = await StateStore.open();
  const vault = new CredentialVault(join(directory, 'vault.enc'), { isEncryptionAvailable: () => false, encryptString: () => { throw Error('not used'); }, decryptString: () => '' });
  vault.set('netease', 'private-cookie-fixture');
  const controller = new AppController(directory, store, vault, '/unused/music-bridge.js', async () => { throw Error('No external calls in fixture'); });
  const web = await startWebServer({ ...options, controller, rendererDirectory: renderer, accessToken: token, port: 0 });
  const headers: Record<string, string> = { 'X-MSync-Request': '1', 'Content-Type': 'application/json', Origin: web.url };
  const call = (path: string, init: RequestInit = {}) => fetch(`${web.url}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  const login = async () => {
    const response = await call('/api/session', { method: 'POST', body: JSON.stringify({ token }) });
    assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\/api/); headers.Cookie = cookie.split(';')[0]!;
  };
  const waitTask = async (id: string): Promise<WebTask> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await (await call(`/api/tasks/${id}`)).json() as { value: WebTask };
      if (result.value.state !== 'running') return result.value;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error('Fixture task timed out');
  };
  const action = async (name: string, ...args: unknown[]) => {
    const response = await call(`/api/actions/${name}`, { method: 'POST', body: JSON.stringify({ args }) });
    assert.equal(response.status, 202); return waitTask((await response.json()).value.id);
  };
  return { web, controller, store, vault, call, headers, login, waitTask, action,
    close: async () => { controller.cancelLogin(); await web.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('web sessions protect state, writes and downloads from unauthenticated and cross-origin requests', async () => {
  const fixture = await setup();
  try {
    const { call, login, web, headers } = fixture;
    assert.equal((await call('/api/state')).status, 401);
    assert.equal((await call('/api/downloads/backup')).status, 401);
    assert.deepEqual((await (await call('/api/session')).json()).value, { authenticated: false });
    assert.equal((await call('/api/session', { method: 'POST', body: JSON.stringify({ token: 'wrong-secret' }) })).status, 401);
    assert.equal((await call('/api/session', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: JSON.stringify({ token }) })).status, 403);
    await login();
    const state = await (await call('/api/state')).text(); assert.doesNotMatch(state, /private-cookie|must-not-be-served|web-fixture-access/);
    assert.equal((await fetch(`${web.url}/api/state`, { headers: { Cookie: headers.Cookie! } })).status, 403);
    assert.equal((await call('/api/state', { headers: { Origin: 'null' } })).status, 403);
    assert.equal((await call('/api/actions/demoMode', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: JSON.stringify({ args: [true] }) })).status, 403);
    assert.equal((await call('/api/state', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).headers.get('access-control-allow-origin'), null);
    await call('/api/session', { method: 'DELETE' }); assert.equal((await call('/api/state')).status, 401);
    assert.equal(fixture.store.load().revision, 0); assert.equal(fixture.vault.get('netease'), 'private-cookie-fixture');
  } finally { await fixture.close(); }
});

test('static serving rejects unknown hosts, traversal and access to credentials or source files', async () => {
  const fixture = await setup();
  try {
    const { web, call } = fixture;
    const page = await fetch(web.url); assert.equal(page.status, 200); assert.match(await page.text(), /MSync fixture/);
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal((await call('/assets/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
    for (const path of ['/credentials.enc', '/settings.json', '/collections.sqlite', '/src/main/index.ts', '/assets/%2e%2e%2fcredentials.enc', '/assets/app.js.map'])
      assert.equal((await call(path)).status, 404, path);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(web.url, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode!); });
      req.on('error', reject); req.end();
    }); assert.equal(status, 403);
  } finally { await fixture.close(); }
});

test('browser APIs preserve demo sync, strict matching and export/import behavior without touching live credentials', async () => {
  const fixture = await setup();
  try {
    await fixture.login();
    assert.equal((await fixture.action('demoMode', true)).state, 'succeeded');
    const simulated = await fixture.action('simulateDemoChange', 'appleMusic', false, 'track');
    const view = simulated.value as ReturnType<AppController['view']>; assert.equal(view.plan?.operations.length, 2);
    const applied = await fixture.action('apply', view.plan!.id);
    assert.equal((applied.value as { report: { applied: number } }).report.applied, 2);
    const response = await fixture.call('/api/downloads/backup'); assert.match(response.headers.get('content-disposition')!, /msync-backup.json/);
    const backup = await response.json(); assert.doesNotMatch(JSON.stringify(backup), /private-cookie/);
    assert.equal((await fixture.action('importBackup', backup)).state, 'succeeded');
    const failed = await fixture.action('importBackup', { credential: 'secret-input' });
    assert.equal(failed.state, 'failed'); assert.match(failed.error!, /备份格式无效/); assert.doesNotMatch(failed.error!, /secret-input/);
    assert.equal((await fixture.call('/api/actions/apply', { method: 'POST', body: JSON.stringify({ args: ['invalid-plan'] }) })).status, 400);
    assert.equal((await fixture.call('/api/actions/__proto__', { method: 'POST', body: JSON.stringify({ args: [] }) })).status, 404);
    assert.equal(fixture.store.load().revision, 0); assert.equal(fixture.vault.get('netease'), 'private-cookie-fixture');
  } finally { await fixture.close(); }
});

test('a task continues after browser disconnect, rejects concurrent writes and exposes completion after refresh', async context => {
  const fixture = await setup(); let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  context.mock.method(fixture.controller, 'scan', async () => { await pending; return fixture.controller.view(); });
  try {
    await fixture.login();
    const response = await fixture.call('/api/actions/scan', { method: 'POST', body: JSON.stringify({ args: [] }) });
    const { id } = (await response.json()).value;
    const running = (await (await fixture.call('/api/activity')).json()).value;
    assert.equal(running.id, id); assert.equal(running.state, 'running');
    assert.equal((await fixture.call('/api/actions/resetHistory', { method: 'POST', body: JSON.stringify({ args: [] }) })).status, 409);
    assert.equal((await fixture.call('/api/state')).status, 200);
    await fixture.call('/api/session', { method: 'DELETE' }); release();
    await fixture.login(); assert.equal((await fixture.waitTask(id)).state, 'succeeded');
    assert.equal(fixture.store.load().revision, 0);
  } finally { release(); await fixture.close(); }
});

test('login can be canceled while its backend task is waiting; errors do not expose credentials', async context => {
  const fixture = await setup(); let rejectLogin!: (error: Error) => void;
  context.mock.method(fixture.controller, 'connectSpotify', () => new Promise((_resolve, reject) => { rejectLogin = reject; }));
  context.mock.method(fixture.controller, 'cancelLogin', () => rejectLogin?.(new MSyncError('已取消授权')));
  try {
    await fixture.login();
    const id = (await (await fixture.call('/api/actions/connectSpotify', { method: 'POST', body: '{"args":[]}' })).json()).value.id;
    assert.equal((await fixture.call('/api/cancel-login', { method: 'POST', body: '{}' })).status, 200);
    assert.equal((await fixture.waitTask(id)).error, '已取消授权');
    assert.equal((await fixture.call('/api/downloads/spotify-diagnostics')).status, 400);
    assert.equal((await fixture.call('/api/actions/scan', { method: 'POST', body: 'not JSON' })).status, 400);
    assert.equal((await fixture.call('/api/actions/scan', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"args":[]}' })).status, 415);
    assert.equal((await fixture.call('/api/session', { method: 'POST', body: JSON.stringify({ token: 'x'.repeat(4096) }) })).status, 413);
  } finally { await fixture.close(); }
});

test('repeated incorrect web access codes are rate limited', async () => {
  const fixture = await setup();
  try {
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await fixture.call('/api/session', { method: 'POST', body: '{"token":"wrong"}' })).status, 401);
    const limited = await fixture.call('/api/session', { method: 'POST', body: JSON.stringify({ token }) });
    assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  } finally { await fixture.close(); }
});

test('localhost binding advertises a reachable address and trusts only the configured development origin', async () => {
  const fixture = await setup({ host: 'localhost', devURL: 'http://127.0.0.1:5173' });
  try {
    assert.equal(new URL(fixture.web.url).hostname, 'localhost'); await fixture.login();
    assert.equal((await fixture.call('/api/state', { headers: { Origin: 'http://127.0.0.1:5173' } })).status, 200);
    assert.equal((await fixture.call('/api/state', { headers: { Origin: 'http://127.0.0.1:5174' } })).status, 403);
  } finally { await fixture.close(); }
});

test('invalid listener names fail before starting a service', async () => {
  const fixture = await setup();
  try {
    await assert.rejects(startWebServer({ controller: fixture.controller, rendererDirectory: '/unused', accessToken: token, host: 'untrusted.example', port: 0 }), /MSYNC_WEB_HOST/);
  } finally { await fixture.close(); }
});
