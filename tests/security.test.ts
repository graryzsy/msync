import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialVault, type SecretCipher } from '../src/main/credentials.js';
import { allowedExternalURL, trustedRenderer } from '../src/main/security.js';

test('external links are restricted to music providers over HTTPS', () => {
  assert.equal(allowedExternalURL('https://music.apple.com/cn/album/example/123').hostname, 'music.apple.com');
  for (const address of ['file:///etc/passwd', 'javascript:alert(1)', 'https://music.apple.com.evil.example/x', 'https://evil.example', 'https://user:pass@music.apple.com/x', 'https://music.apple.com:444/x']) assert.throws(() => allowedExternalURL(address));
});
test('IPC is limited to the expected renderer, not arbitrary local or remote pages', () => {
  assert.equal(trustedRenderer('file:///app/dist/renderer/index.html', 'file:///app/dist/renderer/index.html'), true);
  assert.equal(trustedRenderer('file:///tmp/other.html', 'file:///app/dist/renderer/index.html'), false);
  assert.equal(trustedRenderer('http://127.0.0.1:5173/', '', 'http://127.0.0.1:5173'), true);
  assert.equal(trustedRenderer('http://127.0.0.1:5173/untrusted', '', 'http://127.0.0.1:5173'), false);
});
test('Linux basic_text backend never persists credentials as a plaintext fallback', () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync vault ')); let encrypted = false;
  const cipher: SecretCipher = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text', encryptString: value => { encrypted = true; return Buffer.from(value); }, decryptString: value => value.toString() };
  try {
    const vault = new CredentialVault(join(directory, 'credentials.enc'), cipher); vault.set('spotify', 'secret-fixture');
    assert.equal(vault.mode, 'session'); assert.equal(encrypted, false); assert.equal(vault.get('spotify'), 'secret-fixture');
    assert.equal(new CredentialVault(join(directory, 'credentials.enc'), cipher).get('spotify'), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('secure storage roundtrip keeps only ciphertext on disk', () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync vault ')), path = join(directory, 'credentials.enc');
  const cipher: SecretCipher = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(`encrypted:${Buffer.from(text).toString('base64')}`), decryptString: bytes => Buffer.from(bytes.toString().slice(10), 'base64').toString() };
  try {
    new CredentialVault(path, cipher).set('spotify', 'secret-fixture'); assert.equal(readFileSync(path, 'utf8').includes('secret-fixture'), false);
    assert.equal(new CredentialVault(path, cipher).get('spotify'), 'secret-fixture');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
