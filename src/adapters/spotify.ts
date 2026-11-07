import { z } from 'zod';
import { itemSchema, kindLabels, MSyncError, type Kind, type MusicItem, type MusicService, type Snapshot, type WriteOutcome } from '../core/models.js';
import { http, HTTPError, type Fetcher } from './http.js';
import { refreshToken, type SpotifyToken } from './spotify-oauth.js';
import { assess } from '../core/matcher.js';
import { APIDataError, parseResponse, readJSON } from './response.js';
import { diagnoseSpotifyDetail, spotifyIssueURL, summarizeSpotifyEntity } from './spotify-diagnostics.js';
import type { SpotifyIssueInspection, SpotifyScanIssue } from '../shared/spotify-diagnostics.js';

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
  private scanIssues = new Map<Kind, SpotifyScanIssue[]>();
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
    const issues: SpotifyScanIssue[] = []; this.scanIssues.set(kind, issues);
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
          const source = summarizeSpotifyEntity(entity), url = spotifyIssueURL(kind, source.id);
          issues.push({ kind, position: rowsRead, problem: error.message, field: error.field, source, url });
          const link = url ? `。可在官方页面核实：${url}` : '';
          unreadable++; firstProblem ||= `${error.message}${link}`;
        }
      }
      next = page.next;
    }
    if (new Set(items.map(item => item.id)).size !== items.length || total !== undefined && total !== rowsRead) throw new MSyncError('扫描期间 Spotify 收藏列表变化，请重新扫描');
    const notes = unreadable ? [`${kindLabels[kind]}中有 ${unreadable} 项缺少可用元数据，已读取其余 ${items.length} 项。未读到的条目状态保持未知，不据此推断取消收藏。首项原因：${firstProblem}`] : [];
    return { platform: this.platform, kind, accountID: user.account_id ?? user.id, capturedAt: new Date().toISOString(), items, savedIDs: items.map(item => item.id), isComplete: unreadable === 0, notes };
  }
  getScanIssues(): SpotifyScanIssue[] { return structuredClone([...this.scanIssues.values()].flat()); }
  /** Read-only detail lookups. Never replace scan observations or repair library state here. */
  async inspectScanIssues(input: SpotifyScanIssue[], pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<SpotifyScanIssue[]> {
    const issues = structuredClone(input); let requests = 0, stopped = '';
    const inspection = (finding: SpotifyIssueInspection['finding'], explanation: string, httpStatus?: number): SpotifyIssueInspection => ({ checkedAt: new Date().toISOString(), finding, explanation, httpStatus });
    for (const issue of issues) {
      if (issue.source.isLocal) { issue.inspection = inspection('local_file', '收藏列表明确标记为本地文件，无法确认可跨平台对应的发行版本。'); continue; }
      const id = issue.source.id;
      if (!id || !spotifyIssueURL(issue.kind, id)) { issue.inspection = inspection('not_checked', '收藏记录没有有效的 Spotify 条目 ID，无法请求单项详情。'); continue; }
      if (stopped || requests >= 50) { issue.inspection = inspection('not_checked', stopped || '本次最多检查 50 个条目，其他条目保留原始诊断。'); continue; }
      if (requests) await pause(250);
      requests++;
      try {
        const body = await readJSON(await this.request(`${issue.kind}s/${id}`, { signal: AbortSignal.timeout(20_000) }), 'Spotify 单项详情');
        let problem: string | undefined;
        try { spotifyItem(body, issue.kind, 'Spotify 单项详情'); }
        catch (error) { if (!(error instanceof APIDataError)) throw error; problem = error.message; }
        issue.inspection = diagnoseSpotifyDetail(issue, summarizeSpotifyEntity(body), problem);
      } catch (error) {
        const status = error instanceof HTTPError ? error.status : undefined;
        const explanation = status === 404 || status === 410 ? '当前账号请求此 ID 未找到可用条目；仅凭此响应无法确定原曲名或全球下架原因。'
          : error instanceof MSyncError ? error.message : '单项详情请求未完成，请稍后重试。';
        issue.inspection = inspection('request_failed', explanation, status);
        if (status !== 404 && status !== 410) stopped = '前一请求失败，已暂停后续详情查询，避免重复请求或触发限流。';
      }
    }
    return issues;
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
