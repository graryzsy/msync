import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { MSyncError } from '../core/models.js';
import type { SecretCipher } from './credentials.js';

export const credentialFilename = 'credentials-node-v1.enc';
const associatedData = Buffer.from('msync:credentials:1');
const envelopeSchema = z.object({ version: z.literal(1), iv: z.string(), tag: z.string(), data: z.string() });
export interface SystemKeyEntry {
  getPassword(signal?: AbortSignal): Promise<string | null>;
  setPassword(password: string, signal?: AbortSignal): Promise<void>;
}
function memoryCipher(): SecretCipher {
  const unavailable = (): never => { throw new MSyncError('当前未启用凭据加密保存'); };
  return { isEncryptionAvailable: () => false, encryptString: unavailable, decryptString: unavailable };
}
/** A caller-supplied key must be random 32-byte material, never a web access code. */
export function aesCredentialCipher(keyText: string): SecretCipher {
  if (!/^[a-fA-F0-9]{64}$/u.test(keyText)) throw new MSyncError('MSYNC_CREDENTIAL_KEY 必须是 64 位十六进制加密密钥');
  const key = Buffer.from(keyText, 'hex');
  return {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(associatedData);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.from(JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
    },
    decryptString(bytes) {
      const value = envelopeSchema.parse(JSON.parse(bytes.toString('utf8'))), iv = Buffer.from(value.iv, 'base64'), tag = Buffer.from(value.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new MSyncError('凭据文件格式无效');
      const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(associatedData); decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
    }
  };
}
async function systemEntry(directory: string): Promise<SystemKeyEntry> {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  const canonical = realpathSync(directory), identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const account = createHash('sha256').update(identity).digest('hex');
  // Require a persistent Secret Service on Linux; do not silently select the volatile kernel keyring.
  return new AsyncEntry('local.msync.node.credentials', account, process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined);
}
export async function createCredentialCipher(directory: string, options: {
  key?: string; store?: 'system' | 'memory'; loadEntry?: () => Promise<SystemKeyEntry>;
} = {}): Promise<SecretCipher> {
  if (options.store === 'memory') return memoryCipher();
  if (options.key !== undefined) return aesCredentialCipher(options.key);
  try {
    const entry = await (options.loadEntry?.() ?? systemEntry(directory));
    let key = await entry.getPassword(AbortSignal.timeout(5000));
    if (key === null) {
      if (existsSync(join(directory, credentialFilename))) throw new MSyncError('现有登录凭据的解密密钥缺失；原文件已保留，请恢复系统密钥或提供原后台加密密钥');
      key = randomBytes(32).toString('hex'); await entry.setPassword(key, AbortSignal.timeout(5000));
      if (await entry.getPassword(AbortSignal.timeout(5000)) !== key) throw new Error('Credential store did not retain the key');
    }
    if (!/^[a-fA-F0-9]{64}$/u.test(key)) throw new MSyncError('系统凭据存储中的加密密钥格式无效；原文件已保留');
    return aesCredentialCipher(key);
  } catch (error) {
    if (error instanceof MSyncError) throw error;
    // Missing optional module, locked/unavailable keychain, or headless server: never persist plaintext.
    return memoryCipher();
  }
}
