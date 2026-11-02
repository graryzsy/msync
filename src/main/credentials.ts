import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from '../core/persistence.js';
import { MSyncError } from '../core/models.js';

export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(bytes: Buffer): string;
  getSelectedStorageBackend?(): string;
}
export class CredentialVault {
  readonly mode: 'secure' | 'session';
  private values: Record<string, string> = {};
  constructor(private path: string, private cipher: SecretCipher) {
    this.mode = cipher.isEncryptionAvailable() && cipher.getSelectedStorageBackend?.() !== 'basic_text' ? 'secure' : 'session';
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (this.mode === 'secure' && existsSync(path)) {
      try { this.values = z.record(z.string()).parse(JSON.parse(cipher.decryptString(readFileSync(path)))); }
      catch { throw new MSyncError('系统安全存储无法解锁登录凭据；原文件已保留，请检查钥匙串或密钥环'); }
    }
  }
  get(key: string): string | undefined { return this.values[key]; }
  set(key: string, value?: string): void {
    const next = { ...this.values }; if (value === undefined) delete next[key]; else next[key] = value;
    if (this.mode === 'secure') atomicWrite(this.path, this.cipher.encryptString(JSON.stringify(next)));
    this.values = next;
  }
}
