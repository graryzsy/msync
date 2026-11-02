import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppController } from '../src/main/controller.js';
import { CredentialVault } from '../src/main/credentials.js';
import { StateStore } from '../src/core/store.js';

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
