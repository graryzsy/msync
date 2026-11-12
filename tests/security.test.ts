import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialVault } from '../src/main/credentials.js';
import { aesCredentialCipher, createCredentialCipher, credentialFilename, type SystemKeyEntry } from '../src/main/credential-cipher.js';
import { allowedExternalURL } from '../src/main/security.js';

const key = 'a1'.repeat(32);
test('external links are restricted to music providers over HTTPS', () => {
  assert.equal(allowedExternalURL('https://music.apple.com/cn/album/example/123').hostname, 'music.apple.com');
  for (const address of ['file:///etc/passwd', 'javascript:alert(1)', 'https://music.apple.com.evil.example/x', 'https://evil.example', 'https://user:pass@music.apple.com/x', 'https://music.apple.com:444/x']) assert.throws(() => allowedExternalURL(address));
});
test('memory-only credentials never create a plaintext fallback or access the system keychain', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync vault ')), path = join(directory, credentialFilename);
  try {
    const cipher = await createCredentialCipher(directory, { store: 'memory', key, loadEntry: async () => { throw Error('must not access the system keychain'); } });
    const vault = new CredentialVault(path, cipher); vault.set('spotify', 'secret-fixture');
    assert.equal(vault.mode, 'session'); assert.equal(vault.get('spotify'), 'secret-fixture'); assert.equal(existsSync(path), false);
    assert.equal(new CredentialVault(path, cipher).get('spotify'), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('AES credentials survive restart with an explicit server key and use new nonces for each write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync vault ')), path = join(directory, credentialFilename);
  try {
    const cipher = await createCredentialCipher(directory, { key, loadEntry: async () => { throw Error('explicit key must bypass keychain'); } });
    const vault = new CredentialVault(path, cipher); vault.set('spotify', 'secret-fixture'); const before = readFileSync(path, 'utf8');
    vault.set('spotify', 'secret-fixture'); const after = readFileSync(path, 'utf8');
    assert.notEqual(before, after); assert.doesNotMatch(after, /secret-fixture/); assert.ok(!after.includes(key));
    assert.equal(new CredentialVault(path, aesCredentialCipher(key)).get('spotify'), 'secret-fixture');
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    vault.close(); assert.equal(vault.get('spotify'), undefined); assert.throws(() => vault.set('spotify', 'late-refresh'), /正在退出/);
    assert.equal(readFileSync(path, 'utf8'), after);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('wrong keys and tampered ciphertext are rejected while the stored file is retained', () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync vault ')), path = join(directory, credentialFilename);
  try {
    new CredentialVault(path, aesCredentialCipher(key)).set('netease', 'private-cookie'); const before = readFileSync(path);
    assert.throws(() => new CredentialVault(path, aesCredentialCipher('b2'.repeat(32))), /无法解密/);
    assert.deepEqual(readFileSync(path), before);
    const body = JSON.parse(before.toString()), tag = Buffer.from(body.tag, 'base64'); tag[0] = tag[0]! ^ 1; body.tag = tag.toString('base64');
    writeFileSync(path, JSON.stringify(body)); const damaged = readFileSync(path);
    assert.throws(() => new CredentialVault(path, aesCredentialCipher(key)), /原文件已保留/); assert.deepEqual(readFileSync(path), damaged);
    assert.throws(() => aesCredentialCipher('weak-key'), /64 位/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('a system key is created once, verified, and reused across vault restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync vault ')), path = join(directory, credentialFilename);
  let saved: string | null = null, writes = 0;
  const entry: SystemKeyEntry = { getPassword: async () => saved, setPassword: async value => { saved = value; writes++; } };
  try {
    const first = await createCredentialCipher(directory, { loadEntry: async () => entry });
    new CredentialVault(path, first).set('spotify', 'private-token');
    const second = await createCredentialCipher(directory, { loadEntry: async () => entry });
    assert.equal(new CredentialVault(path, second).get('spotify'), 'private-token'); assert.equal(writes, 1);
    assert.ok(saved); assert.ok(!readFileSync(path, 'utf8').includes(saved));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('an unavailable system store keeps credentials in memory and preserves prior ciphertext', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync vault ')), path = join(directory, credentialFilename);
  try {
    new CredentialVault(path, aesCredentialCipher(key)).set('spotify', 'previous-token'); const before = readFileSync(path);
    const cipher = await createCredentialCipher(directory, { loadEntry: async () => { throw Error('store locked or unavailable'); } });
    const vault = new CredentialVault(path, cipher); vault.set('spotify', 'current-token');
    assert.equal(vault.mode, 'session'); assert.equal(vault.get('spotify'), 'current-token'); assert.deepEqual(readFileSync(path), before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('missing keys for existing credentials are never replaced with new keys', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync vault ')), path = join(directory, credentialFilename); let writes = 0;
  try {
    new CredentialVault(path, aesCredentialCipher(key)).set('netease', 'previous-cookie'); const before = readFileSync(path);
    await assert.rejects(createCredentialCipher(directory, { loadEntry: async () => ({ getPassword: async () => null, setPassword: async () => { writes++; } }) }), /解密密钥缺失/);
    assert.equal(writes, 0); assert.deepEqual(readFileSync(path), before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('legacy credentials remain untouched when creating the independent Node vault', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync vault ')), legacy = join(directory, 'credentials.enc');
  try {
    const bytes = Buffer.from([0, 1, 255, 2]); writeFileSync(legacy, bytes);
    new CredentialVault(join(directory, credentialFilename), await createCredentialCipher(directory, { key })).set('spotify', 'new-login');
    assert.deepEqual(readFileSync(legacy), bytes); assert.doesNotMatch(readFileSync(join(directory, credentialFilename), 'utf8'), /new-login/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
