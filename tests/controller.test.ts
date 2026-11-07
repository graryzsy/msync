import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppController } from '../src/main/controller.js';
import { CredentialVault } from '../src/main/credentials.js';
import { StateStore } from '../src/core/store.js';
import { NeteaseService } from '../src/adapters/netease.js';
import { SpotifyService } from '../src/adapters/spotify.js';
import { MSyncError } from '../src/core/models.js';

test('offline demo applies changes in memory and cannot alter real credentials or account settings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync demo isolation ')), store = await StateStore.open();
  const vault = new CredentialVault(join(directory, 'credentials.enc'), { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('must not encrypt'); }, decryptString: () => '' });
  vault.set('netease', 'real-cookie-fixture');
  let externalCalls = 0;
  try {
    const controller = new AppController(directory, store, vault, '/unused/script.js', async () => { externalCalls++; });
    const settingsBefore = readFileSync(join(directory, 'settings.json'), 'utf8');
    await controller.demoMode(true);
    const simulated = await controller.simulate('appleMusic', false, 'track'); assert.equal(simulated.plan?.operations.length, 2);
    const applied = await controller.apply(simulated.plan!.id); assert.equal(applied.report.applied, 2);
    await assert.rejects(controller.saveSettings({ spotifyClientID: '0'.repeat(32), appleMode: 'disabled' }));
    await assert.rejects(controller.disconnect('netease'));
    await assert.rejects(controller.connectSpotify());
    await assert.rejects(controller.startNeteaseLogin());
    assert.equal(vault.get('netease'), 'real-cookie-fixture'); assert.equal(externalCalls, 0);
    assert.equal(readFileSync(join(directory, 'settings.json'), 'utf8'), settingsBefore);
    assert.equal(store.load().revision, 0); assert.equal(store.load().mappings.length, 0);
    await controller.demoMode(false); assert.equal(controller.view().demo, false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a failed NetEase re-login preserves existing credentials and QR expiry stops further checks', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'msync qr failure ')), store = await StateStore.open();
  const vault = new CredentialVault(join(directory, 'credentials.enc'), { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('must not encrypt'); }, decryptString: () => '' });
  vault.set('netease', 'existing-cookie-fixture');
  context.mock.method(NeteaseService, 'startLogin', async () => ({ key: 'offline-test-key', image: 'data:image/png;base64,fixture' }));
  let checks = 0;
  context.mock.method(NeteaseService, 'checkLogin', async () => {
    checks++;
    if (checks === 1) throw new MSyncError('网易云未接受本次登录请求（代码 405）');
    return { code: 800 };
  });
  try {
    const controller = new AppController(directory, store, vault, '/unused/script.js', async () => {});
    const qr = await controller.startNeteaseLogin();
    await assert.rejects(controller.checkNeteaseLogin(qr.key), /代码 405/);
    assert.equal(vault.get('netease'), 'existing-cookie-fixture');
    assert.equal(store.load().revision, 0);
    assert.doesNotMatch(JSON.stringify(controller.view()), /existing-cookie-fixture/);
    assert.equal((await controller.checkNeteaseLogin(qr.key)).code, 800);
    await assert.rejects(controller.checkNeteaseLogin(qr.key), /二维码已经失效/);
    assert.equal(checks, 2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Spotify diagnostics inspect all failures read-only, export no account data, and clear on account or scan changes', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'msync spotify diagnostics ')), store = await StateStore.open();
  const vault = new CredentialVault(join(directory, 'credentials.enc'), { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('must not encrypt'); }, decryptString: () => '' });
  const clientID = 'a'.repeat(32);
  vault.set('spotify', JSON.stringify({ accessToken: 'secret-access', refreshToken: 'secret-refresh', clientID, expiresAt: '2099-01-01T00:00:00.000Z' }));
  const entity = (id: string, name: string) => ({ id, name, artists: [{ name: 'Artist' }], album: { id: 'album123', name: 'Album', artists: [{ name: 'Artist' }], release_date: '2024-02-29' } });
  const requests: { path: string; method: string }[] = []; let failTrackScan = false;
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; requests.push({ path, method: init?.method ?? 'GET' });
    const body = path === '/v1/me' ? { id: 'secret-user', account_id: 'secret-account', email: 'secret-email' }
      : path === '/v1/me/tracks' ? { items: Array.from({ length: 15 }, (_, index) => ({ track: entity(`missing${index}`, '') })), next: null, total: 15 }
      : path === '/v1/me/albums' ? { items: [], next: null, total: 0 }
      : path === '/v1/me/following' ? { artists: { items: [], next: null, total: 0 } }
      : path.startsWith('/v1/tracks/') ? entity(path.split('/').at(-1)!, path.endsWith('missing0') ? '' : 'Recovered Song') : undefined;
    assert.ok(body, `unexpected request ${path}`);
    return new Response(JSON.stringify(body), { status: failTrackScan && path === '/v1/me/tracks' ? 401 : 200 });
  });
  const inspect = SpotifyService.prototype.inspectScanIssues;
  context.mock.method(SpotifyService.prototype, 'inspectScanIssues', function (this: SpotifyService, input: Parameters<SpotifyService['inspectScanIssues']>[0]) {
    return inspect.call(this, input, async () => {});
  });
  try {
    const controller = new AppController(directory, store, vault, '/unused/script.js', async () => {});
    const settings = { spotifyClientID: clientID, appleMode: 'disabled' as const };
    await controller.saveSettings(settings);
    const scanned = await controller.scan(), stateBefore = store.load();
    assert.equal(scanned.spotifyScanIssues.length, 15); assert.equal(scanned.snapshots[0]?.isComplete, false);
    const checked = await controller.inspectSpotifyIssues(), report = controller.spotifyDiagnosticReport();
    assert.equal(checked.plan?.id, scanned.plan?.id); assert.deepEqual(checked.snapshots, scanned.snapshots); assert.deepEqual(store.load(), stateBefore);
    assert.equal(report.issues.length, 15); assert.equal(report.issues[0]?.inspection?.finding, 'empty_metadata');
    assert.equal(report.issues[1]?.inspection?.finding, 'library_response_incomplete');
    assert.deepEqual(report.collections.find(value => value.kind === 'track'), { kind: 'track', readableCount: 0, issueCount: 15, isComplete: false });
    assert.doesNotMatch(JSON.stringify(report), /secret-|accessToken|refreshToken|accountID|clientID|email/);
    assert.ok(requests.every(value => value.method === 'GET')); assert.equal(requests.filter(value => value.path.startsWith('/v1/tracks/')).length, 15);
    report.issues.splice(0); assert.equal(controller.spotifyDiagnosticReport().issues.length, 15);

    for (const clear of [() => controller.saveSettings(settings), () => controller.resetHistory(), () => controller.importBackup(store.load()),
      async () => { await controller.demoMode(true); await controller.demoMode(false); }]) {
      await clear(); assert.deepEqual(controller.view().spotifyScanIssues, []);
      assert.throws(() => controller.spotifyDiagnosticReport(), /请先扫描/);
      await controller.scan(); assert.equal(controller.view().spotifyScanIssues.length, 15);
    }
    failTrackScan = true;
    const failed = await controller.scan(); assert.deepEqual(failed.spotifyScanIssues, []); assert.ok(failed.plan?.issues.length);
    assert.throws(() => controller.spotifyDiagnosticReport(), /请先扫描/);
    failTrackScan = false; await controller.scan();
    await controller.disconnect('spotify'); assert.deepEqual(controller.view().spotifyScanIssues, []);
    assert.throws(() => controller.spotifyDiagnosticReport(), /请先扫描/);
    assert.equal(vault.get('spotify'), undefined);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
