import { z } from 'zod';
import { itemSchema, kindLabels, MSyncError, type Kind, type MusicItem, type MusicService, type Snapshot, type WriteOutcome } from '../core/models.js';
import { http, type Fetcher } from './http.js';
import { refreshToken, type SpotifyToken } from './spotify-oauth.js';
import { assess } from '../core/matcher.js';
import { APIDataError, parseResponse, readJSON } from './response.js';

const optionalText = z.string().nullish().transform(value => value ?? undefined);
const optionalNumber = z.number().nonnegative().nullish().transform(value => value ?? undefined);
const artistSchema = z.object({ name: z.string().trim().min(1) });
const externalIDs = z.object({ upc: optionalText, isrc: optionalText }).nullish().transform(value => value ?? undefined);
const albumSchema = z.object({ name: z.string().trim().min(1), artists: z.array(artistSchema), release_date: optionalText, external_ids: externalIDs });
const entitySchema = z.object({ id: z.string().min(1), name: z.string().trim().min(1), artists: z.array(artistSchema).nullish(), album: albumSchema.nullish(),
  release_date: optionalText, external_ids: externalIDs, disc_number: optionalNumber, track_number: optionalNumber, duration_ms: optionalNumber,
  external_urls: z.object({ spotify: optionalText }).nullish(), is_local: z.boolean().nullish(), linked_from: z.object({ id: optionalText }).nullish() });
export function spotifyItem(input: unknown, kind: Kind, context = `Spotify ${kindLabels[kind]}`): MusicItem {
  const object = parseResponse(entitySchema, input, context);
  if (object.is_local) throw new APIDataError(`${context} 是本地文件，无法确认平台发行版本`);
  if (object.linked_from?.id && object.linked_from.id !== object.id) throw new APIDataError(`${context} 返回了重定向曲目，原发行版本状态保持未知`);
  const album = kind === 'album' ? parseResponse(albumSchema, input, context) : object.album;
  return parseResponse(itemSchema, { platform: 'spotify', kind, id: object.id, title: object.name, artists: kind === 'artist' ? [object.name] : object.artists?.map(a => a.name) ?? [],
    ...(album ? { release: { title: album.name, artists: album.artists.map(a => a.name), ...(album.release_date ? { date: { value: album.release_date } } : {}), ...(album.external_ids?.upc ? { barcode: album.external_ids.upc } : {}) } } : {}),
    isrc: object.external_ids?.isrc, discNumber: object.disc_number && object.disc_number > 0 ? object.disc_number : undefined,
    trackNumber: object.track_number && object.track_number > 0 ? object.track_number : undefined, durationMS: object.duration_ms, url: object.external_urls?.spotify }, context);
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
    const user = parseResponse(z.object({ id: z.string().min(1), account_id: optionalText }), await readJSON(await this.request('me'), 'Spotify GET /me'), 'Spotify GET /me');
    const collection = kind === 'artist' ? 'me/following' : `me/${kind}s`;
    const context = `Spotify GET /${collection}`;
    let next: string | null = kind === 'artist' ? `${collection}?type=artist&limit=50` : `${collection}?limit=50`;
    const items: MusicItem[] = [], seen = new Set<string>(); let total: number | undefined;
    let rowsRead = 0, unreadable = 0, firstProblem = '';
    while (next) {
      if (seen.has(next)) throw new MSyncError('Spotify 分页重复，请重新扫描'); seen.add(next);
      const root = await readJSON(await this.request(next), context);
      const envelope = kind === 'artist' ? parseResponse(z.object({ artists: z.unknown() }), root, context).artists : root;
      const page = parseResponse(z.object({ items: z.array(z.unknown()), next: z.string().nullable(), total: z.number().int().nonnegative().nullish() }), envelope, context);
      total ??= page.total ?? undefined;
      for (const row of page.items) {
        rowsRead++;
        const rowContext = `${context} 第 ${rowsRead} 项`;
        let entity: unknown;
        try {
          entity = kind === 'artist' ? row : parseResponse(z.object({ track: z.unknown(), album: z.unknown() }), row, rowContext)[kind];
          items.push(spotifyItem(entity, kind, rowContext));
        } catch (error) {
          if (!(error instanceof APIDataError)) throw error;
          const id = entity && typeof entity === 'object' && 'id' in entity ? entity.id : undefined;
          const link = typeof id === 'string' && /^[A-Za-z0-9]{1,64}$/u.test(id) ? `。可在官方页面核实：https://open.spotify.com/${kind}/${id}` : '';
          unreadable++; firstProblem ||= `${error.message}${link}`;
        }
      }
      next = page.next;
    }
    if (new Set(items.map(item => item.id)).size !== items.length || total !== undefined && total !== rowsRead) throw new MSyncError('扫描期间 Spotify 收藏列表变化，请重新扫描');
    const notes = unreadable ? [`${kindLabels[kind]}中有 ${unreadable} 项缺少可用元数据，已读取其余 ${items.length} 项。未读到的条目状态保持未知，不据此推断取消收藏。首项原因：${firstProblem}`] : [];
    return { platform: this.platform, kind, accountID: user.account_id ?? user.id, capturedAt: new Date().toISOString(), items, savedIDs: items.map(item => item.id), isComplete: unreadable === 0, notes };
  }
  async search(item: MusicItem): Promise<MusicItem[]> {
    const url = new URL('https://api.spotify.com/v1/search');
    url.search = new URLSearchParams({ q: [item.title, ...item.artists, item.release?.title ?? ''].join(' '), type: item.kind, limit: '10' }).toString();
    const root = parseResponse(z.record(z.unknown()), await readJSON(await this.request(url), 'Spotify GET /search'), 'Spotify GET /search');
    const page = parseResponse(z.object({ items: z.array(z.unknown()) }), root[`${item.kind}s`], `Spotify GET /search ${item.kind}`);
    const items: MusicItem[] = [];
    for (const row of page.items) {
      if (item.kind === 'album') {
        const { id } = parseResponse(z.object({ id: z.string().regex(/^[A-Za-z0-9]+$/u) }), row, 'Spotify 专辑搜索结果');
        items.push(spotifyItem(await readJSON(await this.request(`albums/${id}`), 'Spotify GET /albums'), 'album'));
      } else items.push(spotifyItem(row, item.kind));
    }
    return items;
  }
  async setSaved(saved: boolean, item: MusicItem): Promise<WriteOutcome> {
    if (item.platform !== 'spotify' || !/^[A-Za-z0-9]+$/u.test(item.id)) throw new MSyncError('Spotify 条目 ID 无效');
    if (item.release) {
      const current = spotifyItem(await readJSON(await this.request(`${item.kind}s/${item.id}`), `Spotify GET /${item.kind}s`), item.kind);
      if (current.id !== item.id || assess(item, current).decision === 'different') throw new MSyncError('Spotify 返回了不同的发行版本或重定向条目，停止写入');
    }
    const url = new URL('https://api.spotify.com/v1/me/library'); url.searchParams.set('uris', `spotify:${item.kind}:${item.id}`);
    await this.request(url, { method: saved ? 'PUT' : 'DELETE' }); return { applied: true };
  }
}
