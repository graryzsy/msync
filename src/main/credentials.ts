import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from '../core/persistence.js';
import { MSyncError } from '../core/models.js';

export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(bytes: Buffer): string;
}
export class CredentialVault {
  readonly mode: 'secure' | 'session';
  private values: Record<string, string> = {};
  private closed = false;
  constructor(private path: string, private cipher: SecretCipher) {
    this.mode = cipher.isEncryptionAvailable() ? 'secure' : 'session';
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (this.mode === 'secure' && existsSync(path)) {
      try { this.values = z.record(z.string()).parse(JSON.parse(cipher.decryptString(readFileSync(path)))); }
      catch { throw new MSyncError('登录凭据无法解密；原文件已保留，请检查系统凭据存储或后台加密密钥'); }
    }
  }
  get(key: string): string | undefined { return this.values[key]; }
  set(key: string, value?: string): void {
    if (this.closed) throw new MSyncError('后台正在退出，登录凭据保持原样');
    const next = { ...this.values }; if (value === undefined) delete next[key]; else next[key] = value;
    if (this.mode === 'secure') atomicWrite(this.path, this.cipher.encryptString(JSON.stringify(next)));
    this.values = next;
  }
  close(): void { this.closed = true; this.values = {}; }
}
