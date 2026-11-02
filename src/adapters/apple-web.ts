import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from '../core/persistence.js';
import { normalize } from '../core/matcher.js';
import { itemSchema, MSyncError, type Kind, type MusicItem, type MusicService, type Snapshot, type WriteOutcome } from '../core/models.js';

const recordSchema = z.object({ item: itemSchema, saved: z.boolean(), checkedAt: z.string().datetime() });
export type ManualRecord = z.infer<typeof recordSchema>;
export function appleCatalogID(address: string, kind: Kind): string {
  let url: URL;
  try { url = new URL(address); } catch { throw new MSyncError('请粘贴 Apple Music 的 https 页面链接'); }
  if (url.protocol !== 'https:' || url.hostname !== 'music.apple.com' || url.username || url.password) throw new MSyncError('仅接受 music.apple.com 的 https 页面链接');
  const parts = url.pathname.split('/').filter(Boolean), type = parts[1], pageID = parts.at(-1);
  if (!pageID || !/^\d+$/u.test(pageID)) throw new MSyncError('Apple Music 链接中未找到目录 ID');
  if (kind === 'track') {
    const song = url.searchParams.getAll('i');
    if (type === 'album' && song.length === 1 && /^\d+$/u.test(song[0]!)) return song[0]!;
    if (type === 'song') return pageID;
  } else if (kind === 'album' && type === 'album') return pageID;
  else if (kind === 'artist' && type === 'artist') return pageID;
  throw new MSyncError('页面链接与收藏类型不一致；歌曲链接需要包含曲目 ID');
}

/** Explicit user observations, never a fabricated live Apple Music library. */
export class ManualAppleLibrary {
  private records: ManualRecord[];
  constructor(private path?: string) {
    if (path) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.records = path && existsSync(path) ? z.array(recordSchema).parse(JSON.parse(readFileSync(path, 'utf8'))) : [];
  }
  list(): ManualRecord[] { return structuredClone(this.records); }
  record(item: MusicItem, saved: boolean): void {
    item = itemSchema.parse(item);
    if (item.platform !== 'appleMusic' || !item.url) throw new MSyncError('请提供完整 Apple Music 条目信息和页面链接');
    if (item.id !== `web-${item.kind}:${appleCatalogID(item.url, item.kind)}`) throw new MSyncError('Apple Music 目录 ID 与页面不一致');
    const next = this.records.filter(record => record.item.id !== item.id);
    next.push({ item, saved, checkedAt: new Date().toISOString() });
    if (this.path) atomicWrite(this.path, JSON.stringify(next));
    this.records = next;
  }
}
export class AppleWebService implements MusicService {
  readonly platform = 'appleMusic';
  constructor(private library: ManualAppleLibrary, private accountID: string) {}
  async snapshot(kind: Kind): Promise<Snapshot> {
    const records = this.library.list().filter(record => record.item.kind === kind);
    return { platform: this.platform, kind, accountID: this.accountID, capturedAt: new Date().toISOString(), items: records.map(record => record.item), savedIDs: records.filter(record => record.saved).map(record => record.item.id), isComplete: false,
      notes: ['网页确认模式仅记录你手动核实的状态，不自动读取网页或检测网页变化', '新增和取消需要在系统浏览器中完成，再返回这里确认实际状态'] };
  }
  async search(item: MusicItem): Promise<MusicItem[]> {
    return this.library.list().filter(record => record.item.kind === item.kind && normalize(record.item.title) === normalize(item.title)).map(record => record.item);
  }
  async setSaved(_saved: boolean, item: MusicItem): Promise<WriteOutcome> {
    return { applied: false, message: '请打开 Apple Music 页面完成操作，再在网页确认页记录实际状态', url: item.url };
  }
}
