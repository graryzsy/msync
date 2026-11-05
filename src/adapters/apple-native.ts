import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { normalize } from '../core/matcher.js';
import { MSyncError, type Kind, type MusicItem, type MusicService, type Snapshot, type WriteOutcome } from '../core/models.js';

const execute = promisify(execFile);
const rowSchema = z.object({
  persistentID: z.string(), title: z.string(), artist: z.string(), album: z.string(), albumArtist: z.string(),
  date: z.string().nullable(), durationMS: z.number().nullish(), discNumber: z.number().nullish(), trackNumber: z.number().nullish(), favorited: z.boolean().nullable(), albumFavorited: z.boolean().nullable()
});
type NativeRow = z.infer<typeof rowSchema>;
export function nativeSnapshot(kind: Kind, accountID: string, rows: NativeRow[]): Snapshot {
  if (kind === 'artist') throw new MSyncError('Music.app 脚本没有完整艺人喜爱列表；可切换到网页确认模式管理');
  const items: MusicItem[] = [], savedIDs: string[] = [], albums = new Map<string, { item: MusicItem; saved: boolean }>();
  for (const row of rows) {
    const release = { title: row.album, artists: [row.albumArtist], ...(row.date ? { date: { value: row.date } } : {}) };
    if (kind === 'track' && row.favorited !== null) {
      const item: MusicItem = { platform: 'appleMusic', kind, id: row.persistentID, nativeReference: row.persistentID, title: row.title, artists: [row.artist], release,
        ...(row.durationMS && row.durationMS > 0 ? { durationMS: row.durationMS } : {}), ...(row.discNumber && row.discNumber > 0 ? { discNumber: row.discNumber } : {}), ...(row.trackNumber && row.trackNumber > 0 ? { trackNumber: row.trackNumber } : {}) };
      items.push(item); if (row.favorited) savedIDs.push(item.id);
    } else if (kind === 'album' && row.albumFavorited !== null && row.album) {
      const id = `local-album:${[row.album, row.albumArtist, row.date ?? 'unknown'].map(value => Buffer.from(value).toString('base64')).join('.')}`;
      if (albums.has(id) && albums.get(id)!.saved !== row.albumFavorited) throw new MSyncError('专辑喜爱状态存在冲突，请在音乐 App 中核实');
      albums.set(id, { item: { platform: 'appleMusic', kind, id, title: row.album, artists: [row.albumArtist], release, nativeReference: row.persistentID }, saved: row.albumFavorited });
    }
  }
  for (const [id, entry] of albums) { items.push(entry.item); if (entry.saved) savedIDs.push(id); }
  if (rows.length && !items.length) throw new MSyncError('当前 Music.app 未提供所需喜爱属性，请检查版本与自动化权限');
  return { platform: 'appleMusic', kind, accountID, capturedAt: new Date().toISOString(), items, savedIDs, isComplete: false,
    notes: ['仅确认本机资料库中明确可读的喜爱状态；缺失条目保持未知', '更换 Apple 账户后需要重新建立同步基线'] };
}
export class AppleNativeService implements MusicService {
  readonly platform = 'appleMusic';
  readonly unsupportedKinds = { artist: '本机 Music.app 模式没有完整艺人喜爱接口；如需处理艺人，请使用网页确认模式。' };
  constructor(private scriptPath: string) {}
  private async invoke(payload: Record<string, unknown>): Promise<unknown> {
    if (process.platform !== 'darwin') throw new MSyncError('本机音乐 App 接入仅适用于 macOS；请使用网页确认模式');
    try {
      const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', this.scriptPath, JSON.stringify(payload)], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
      return JSON.parse(stdout);
    } catch { throw new MSyncError('Music.app 操作未完成，请打开音乐 App、等待资料库同步并允许自动化权限'); }
  }
  async snapshot(kind: Kind): Promise<Snapshot> {
    if (kind === 'artist') throw new MSyncError('Music.app 脚本没有完整艺人喜爱接口；艺人需使用网页确认模式');
    const scan = z.object({ accountID: z.string(), rows: z.array(rowSchema) }).parse(await this.invoke({ action: 'scan' }));
    return nativeSnapshot(kind, scan.accountID, scan.rows);
  }
  async search(item: MusicItem): Promise<MusicItem[]> {
    const snapshot = await this.snapshot(item.kind), title = normalize(item.title);
    return snapshot.items.filter(candidate => normalize(candidate.title).includes(title) || title.includes(normalize(candidate.title)));
  }
  async setSaved(saved: boolean, item: MusicItem): Promise<WriteOutcome> {
    if (item.platform !== 'appleMusic') throw new MSyncError('目标平台不一致');
    if (item.kind === 'artist') return { applied: false, message: '请在 Apple Music 页面完成艺人喜爱操作', url: item.url };
    const snapshot = await this.snapshot(item.kind), live = snapshot.items.find(candidate => candidate.id === item.id);
    if (!live?.nativeReference || !live.release || !item.release) return { applied: false, message: '请先在 Music.app 中找到并加入对应发行版本，再重新扫描', url: item.url };
    if (live.release.date && live.release.date.value !== item.release.date?.value) throw new MSyncError('实际发行日期与已确认对应关系不同，停止写入');
    const result = z.object({ applied: z.literal(true) }).parse(await this.invoke({ action: 'write', accountID: snapshot.accountID, persistentID: live.nativeReference,
      kind: item.kind, title: live.title, album: live.release.title, albumArtist: live.release.artists[0] ?? '', date: live.release.date?.value ?? null, saved }));
    return result;
  }
}
