import { z } from 'zod';
import { itemSchema, MSyncError, type Kind, type MusicItem, type MusicService, type Snapshot, type WriteOutcome } from '../core/models.js';
import { http, type Fetcher } from './http.js';
import { refreshToken, type SpotifyToken } from './spotify-oauth.js';
import { assess } from '../core/matcher.js';

const artistSchema = z.object({ name: z.string() });
const albumSchema = z.object({ name: z.string(), artists: z.array(artistSchema), release_date: z.string().optional(), external_ids: z.object({ upc: z.string().optional() }).optional() });
export function spotifyItem(input: unknown, kind: Kind): MusicItem {
  const object = z.object({ id: z.string().min(1), name: z.string(), artists: z.array(artistSchema).optional(), album: albumSchema.optional(),
    release_date: z.string().optional(), external_ids: z.object({ upc: z.string().optional(), isrc: z.string().optional() }).optional(),
    disc_number: z.number().optional(), track_number: z.number().optional(), duration_ms: z.number().optional(), external_urls: z.object({ spotify: z.string() }).optional() }).parse(input);
  const album = kind === 'album' ? albumSchema.parse(input) : object.album;
  return itemSchema.parse({ platform: 'spotify', kind, id: object.id, title: object.name, artists: kind === 'artist' ? [object.name] : object.artists?.map(a => a.name) ?? [],
    ...(album ? { release: { title: album.name, artists: album.artists.map(a => a.name), ...(album.release_date ? { date: { value: album.release_date } } : {}), ...(album.external_ids?.upc ? { barcode: album.external_ids.upc } : {}) } } : {}),
    isrc: object.external_ids?.isrc, discNumber: object.disc_number && object.disc_number > 0 ? object.disc_number : undefined,
    trackNumber: object.track_number && object.track_number > 0 ? object.track_number : undefined, durationMS: object.duration_ms, url: object.external_urls?.spotify });
}
export class SpotifyService implements MusicService {
  readonly platform = 'spotify';
  private refreshing?: Promise<void>;
  constructor(private token: SpotifyToken, private persist: (token: SpotifyToken) => void, private fetcher: Fetcher = fetch) {}
  private async request(path: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, 'https://api.spotify.com/v1/');
    if (url.origin !== 'https://api.spotify.com' || !url.pathname.startsWith('/v1/')) throw new MSyncError('Spotify 返回了非预期地址');
    if (Date.parse(this.token.expiresAt) - Date.now() < 60_000) {
      this.refreshing ??= refreshToken(this.token, this.fetcher).then(token => { this.persist(token); this.token = token; }).finally(() => { this.refreshing = undefined; });
      await this.refreshing;
    }
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${this.token.accessToken}`);
    return http(url, { ...init, headers }, this.fetcher);
  }
  async snapshot(kind: Kind): Promise<Snapshot> {
    const user = z.object({ id: z.string(), account_id: z.string().optional() }).parse(await (await this.request('me')).json());
    let next: string | null = kind === 'artist' ? 'me/following?type=artist&limit=50' : `me/${kind}s?limit=50`;
    const items: MusicItem[] = [], seen = new Set<string>(); let total: number | undefined;
    while (next) {
      if (seen.has(next)) throw new MSyncError('Spotify 分页重复，请重新扫描'); seen.add(next);
      const root = await (await this.request(next)).json() as Record<string, unknown>;
      const page = z.object({ items: z.array(z.unknown()), next: z.string().nullable(), total: z.number().int().optional() }).parse(kind === 'artist' ? root.artists : root);
      total ??= page.total;
      for (const row of page.items) {
        const entity = kind === 'artist' ? row : z.record(z.unknown()).parse(row)[kind];
        items.push(spotifyItem(entity, kind));
      }
      next = page.next;
    }
    if (new Set(items.map(item => item.id)).size !== items.length || total !== undefined && total !== items.length) throw new MSyncError('扫描期间 Spotify 收藏列表变化，请重新扫描');
    return { platform: this.platform, kind, accountID: user.account_id ?? user.id, capturedAt: new Date().toISOString(), items, savedIDs: items.map(item => item.id), isComplete: true, notes: [] };
  }
  async search(item: MusicItem): Promise<MusicItem[]> {
    const url = new URL('https://api.spotify.com/v1/search');
    url.search = new URLSearchParams({ q: [item.title, ...item.artists, item.release?.title ?? ''].join(' '), type: item.kind, limit: '10' }).toString();
    const root = await (await this.request(url)).json() as Record<string, unknown>;
    const page = z.object({ items: z.array(z.unknown()) }).parse(root[`${item.kind}s`]);
    const items: MusicItem[] = [];
    for (const row of page.items) {
      if (item.kind === 'album') {
        const { id } = z.object({ id: z.string().regex(/^[A-Za-z0-9]+$/u) }).parse(row);
        items.push(spotifyItem(await (await this.request(`albums/${id}`)).json(), 'album'));
      } else items.push(spotifyItem(row, item.kind));
    }
    return items;
  }
  async setSaved(saved: boolean, item: MusicItem): Promise<WriteOutcome> {
    if (item.platform !== 'spotify' || !/^[A-Za-z0-9]+$/u.test(item.id)) throw new MSyncError('Spotify 条目 ID 无效');
    if (item.release) {
      const current = spotifyItem(await (await this.request(`${item.kind}s/${item.id}`)).json(), item.kind);
      if (current.id !== item.id || assess(item, current).decision === 'different') throw new MSyncError('Spotify 返回了不同的发行版本或重定向条目，停止写入');
    }
    const url = new URL('https://api.spotify.com/v1/me/library'); url.searchParams.set('uris', `spotify:${item.kind}:${item.id}`);
    await this.request(url, { method: saved ? 'PUT' : 'DELETE' }); return { applied: true };
  }
}
