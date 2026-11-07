import test from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyService } from '../src/adapters/spotify.js';
import { diagnoseSpotifyDetail, summarizeSpotifyEntity } from '../src/adapters/spotify-diagnostics.js';
import type { SpotifyToken } from '../src/adapters/spotify-oauth.js';
import type { Fetcher } from '../src/adapters/http.js';
import type { SpotifyScanIssue } from '../src/shared/spotify-diagnostics.js';
import { observedState } from '../src/core/models.js';

const token: SpotifyToken = { accessToken: 'private-access-token', refreshToken: 'private-refresh-token', clientID: '0'.repeat(32), expiresAt: '2099-01-01T00:00:00Z' };
const track = (id: string) => ({ id, name: 'Song', artists: [{ name: 'Artist' }],
  album: { id: 'album123', name: 'Original Album', artists: [{ name: 'Artist' }], release_date: '2024-02-29', release_date_precision: 'day' } });
const issue = (id = 'unavailable123'): SpotifyScanIssue => ({ kind: 'track', position: 711, problem: '名称为空', field: 'name', source: summarizeSpotifyEntity({ ...track(id), name: '' }) });
function transport(responses: { status?: number; body?: unknown; error?: boolean }[]) {
  const calls: { url: string; method: string }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    const response = responses.shift(); if (!response || response.error) throw new Error('private-network-error');
    return new Response(JSON.stringify(response.body ?? {}), { status: response.status ?? 200 });
  };
  return { calls, fetcher };
}
const noPause = async () => {};

test('all 15 unreadable records retain positions and selected metadata across pages without implying deletion', async () => {
  const damaged = Array.from({ length: 15 }, (_, index) => ({ track: { ...track(`missing${index}`), name: '' } }));
  damaged[13] = { track: { ...track('missing13'), album: { ...track('x').album, name: '' } } };
  const rows = [{ track: track('readable123') }, ...damaged];
  const fixture = transport([{ body: { id: 'private-user' } },
    { body: { items: rows.slice(0, 8), next: 'https://api.spotify.com/v1/me/tracks?offset=8', total: 16 } },
    { body: { items: rows.slice(8), next: null, total: 16 } },
    { body: { id: 'private-user' } }, { body: { items: [], next: null, total: 0 } }]);
  const service = new SpotifyService(token, () => {}, fixture.fetcher), snapshot = await service.snapshot('track');
  const problems = service.getScanIssues();
  assert.equal(problems.length, 15); assert.deepEqual(problems.map(value => value.source.id), damaged.map(value => value.track.id));
  assert.deepEqual(problems.map(value => value.position), Array.from({ length: 15 }, (_, index) => index + 2));
  assert.equal(problems[13]?.field, 'album.name'); assert.equal(problems[0]?.source.album?.name, 'Original Album');
  assert.equal(problems[0]?.url, 'https://open.spotify.com/track/missing0');
  assert.deepEqual(snapshot.savedIDs, ['readable123']); assert.equal(snapshot.isComplete, false);
  for (const value of problems) assert.equal(observedState(snapshot, value.source.id!), undefined);
  problems[0]!.source.name = 'mutated'; assert.equal(service.getScanIssues()[0]?.source.name, undefined);
  await service.snapshot('track'); assert.deepEqual(service.getScanIssues(), []);
});

test('diagnostics whitelist catalog fields instead of exporting raw payloads or credentials', () => {
  const source = summarizeSpotifyEntity({ ...track('catalog123'), name: '  Song  ', access_token: 'secret-access', refresh_token: 'secret-refresh',
    cookie: 'secret-cookie', email: 'secret-email', profile: { id: 'secret-user' }, headers: { Authorization: 'secret-bearer' },
    artists: [{ name: 'Artist', token: 'secret-artist' }],
    album: { ...track('x').album, accountID: 'secret-account', external_ids: { upc: '123456789012' } },
    external_urls: { spotify: 'https://example.com/?token=secret-url' },
    external_ids: { isrc: 'USABC2400001', token: 'secret-ids' },
    available_markets: ['US', 'GB'], is_playable: false, restrictions: { reason: 'market' }, linked_from: { id: 'original123', token: 'secret-linked' } });
  assert.doesNotMatch(JSON.stringify(source), /secret-|private-/);
  assert.equal(source.name, 'Song'); assert.equal(source.album?.releaseDate, '2024-02-29');
  assert.equal(source.availableMarketCount, 2); assert.equal(source.isPlayable, false); assert.equal(source.restrictionReason, 'market');
  assert.equal(source.isrc, 'USABC2400001'); assert.equal(source.linkedFromID, 'original123');
  for (const [input, expected] of [[undefined, 'missing'], [null, 'null'], ['', 'empty'], ['  ', 'empty'], [42, 'invalid_type']] as const)
    assert.equal(summarizeSpotifyEntity({ name: input }).nameState, expected);
  assert.equal(summarizeSpotifyEntity(null).recordState, 'null');
  assert.equal(summarizeSpotifyEntity({}).isPlayable, undefined); assert.equal(summarizeSpotifyEntity({}).availableMarketCount, undefined);
  assert.equal(summarizeSpotifyEntity({ id: 'https://evil.example/private' }).id, undefined);
});

test('detail inspection differentiates list-only missing metadata, empty catalog metadata and explicit restrictions', async () => {
  const fixture = transport([
    { body: track('recover123') }, { body: { ...track('blank123'), name: '', is_playable: false } },
    { body: { ...track('market123'), restrictions: { reason: 'market' } } },
    { body: { ...track('product123'), restrictions: { reason: 'product' } } },
    { body: { ...track('explicit123'), restrictions: { reason: 'explicit' } } },
    { body: { ...track('broken123'), album: { name: '', artists: [] } } }
  ]);
  const input = ['recover123', 'blank123', 'market123', 'product123', 'explicit123', 'broken123'].map(id => issue(id));
  const before = structuredClone(input), delays: number[] = [];
  const service = new SpotifyService(token, () => {}, fixture.fetcher);
  const checked = await service.inspectScanIssues(input, async ms => { delays.push(ms); });
  assert.deepEqual(checked.map(value => value.inspection?.finding), ['library_response_incomplete', 'empty_metadata', 'region_restricted', 'account_restricted', 'account_restricted', 'metadata_incomplete']);
  assert.equal(checked[1]?.inspection?.detail?.isPlayable, false);
  assert.match(checked[2]!.inspection!.explanation, /不代表全球下架/);
  assert.deepEqual(input, before); assert.deepEqual(service.getScanIssues(), []);
  assert.deepEqual(delays, [250, 250, 250, 250, 250]);
  assert.ok(fixture.calls.every(call => call.method === 'GET' && /^\/v1\/tracks\//u.test(new URL(call.url).pathname)));
});

test('local files, relinking and changed releases cannot be promoted to a confirmed match', async () => {
  const local = issue('local123'); local.source.isLocal = true;
  const noID = issue(); noID.source.id = undefined;
  const fixture = transport([{ body: track('substitute123') }, { body: { ...track('linked123'), linked_from: { id: 'original123' } } },
    { body: { ...track('release123'), album: { ...track('x').album, id: 'compilation123' } } },
    { body: { ...track('date123'), album: { ...track('x').album, release_date: '2025-02-28' } } }]);
  const checked = await new SpotifyService(token, () => {}, fixture.fetcher).inspectScanIssues([local, noID, issue('requested123'), issue('linked123'), issue('release123'), issue('date123')], noPause);
  assert.deepEqual(checked.map(value => value.inspection?.finding), ['local_file', 'not_checked', 'relinked', 'relinked', 'release_changed', 'release_changed']);
  assert.equal(fixture.calls.length, 4);
  assert.equal(diagnoseSpotifyDetail(issue(), summarizeSpotifyEntity({ name: 'Song' })).finding, 'metadata_incomplete');
});

test('a missing catalog item retains HTTP status and does not prevent checking the next item', async () => {
  const fixture = transport([{ status: 404, body: { error: { message: 'secret-body' } } }, { body: track('recover123') }]);
  const checked = await new SpotifyService(token, () => {}, fixture.fetcher).inspectScanIssues([issue('missing123'), issue('recover123')], noPause);
  assert.equal(checked[0]?.inspection?.httpStatus, 404); assert.equal(checked[0]?.inspection?.finding, 'request_failed');
  assert.match(checked[0]!.inspection!.explanation, /无法确定原曲名或全球下架原因/);
  assert.equal(checked[1]?.inspection?.finding, 'library_response_incomplete'); assert.equal(fixture.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(checked), /secret-body|private-access-token/);
});

test('rate limits, auth failures and network errors stop later lookups without leaking response contents', async () => {
  for (const failure of [{ status: 401 }, { status: 403 }, { status: 429 }, { status: 503 }, { error: true }]) {
    const fixture = transport([{ ...failure, body: { message: 'secret-body' } }]);
    const checked = await new SpotifyService(token, () => {}, fixture.fetcher).inspectScanIssues([issue('one123'), issue('two123')], noPause);
    assert.equal(checked[0]?.inspection?.finding, 'request_failed'); assert.equal(checked[1]?.inspection?.finding, 'not_checked');
    assert.equal(fixture.calls.length, 1); assert.doesNotMatch(JSON.stringify(checked), /secret-body|private-/);
  }
});

test('a diagnostic action bounds detail requests without treating unchecked items as absent', async () => {
  const input = Array.from({ length: 51 }, (_, index) => issue(`track${index}`));
  const fixture = transport(input.map(value => ({ body: track(value.source.id!) })));
  const checked = await new SpotifyService(token, () => {}, fixture.fetcher).inspectScanIssues(input, noPause);
  assert.equal(fixture.calls.length, 50); assert.equal(checked[50]?.inspection?.finding, 'not_checked');
  assert.equal(input[50]?.inspection, undefined);
});
