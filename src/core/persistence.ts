import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** The destination is replaced only after the new contents have reached the filesystem. */
export function atomicWrite(path: string, data: Uint8Array | string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  try {
    handle = openSync(temporary, 'wx', 0o600);
    writeFileSync(handle, data); fsyncSync(handle); closeSync(handle); handle = undefined;
    renameSync(temporary, path);
    if (process.platform !== 'win32') {
      let directory: number | undefined;
      try { directory = openSync(dirname(path), 'r'); fsyncSync(directory); } catch { /* Some filesystems do not support directory fsync. */ }
      finally { if (directory !== undefined) closeSync(directory); }
    }
  } finally {
    if (handle !== undefined) closeSync(handle);
    try { unlinkSync(temporary); } catch { /* Already renamed, or never created. */ }
  }
}
