import test from 'node:test';
import assert from 'node:assert/strict';
import { pkceChallenge, authorizationCode, refreshToken, SpotifyLogin, type SpotifyToken } from '../src/adapters/spotify-oauth.js';
import { SpotifyService } from '../src/adapters/spotify.js';
import type { Fetcher } from '../src/adapters/http.js';
import { nativeSnapshot } from '../src/adapters/apple-native.js';
import { AppleWebService, appleCatalogID, ManualAppleLibrary } from '../src/adapters/apple-web.js';
import { item, mapping, snap, stateFor } from './fixtures.js';
import { planSync } from '../src/core/planner.js';
import { MSyncError } from '../src/core/models.js';

const token: SpotifyToken = { accessToken: 'fixture', refreshToken: 'a+b', clientID: '0'.repeat(32), expiresAt: '2099-01-01T00:00:00Z' };
function transport(responses: { status?: number; body?: unknown }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url: String(url), init }); const response = responses.shift(); if (!response) throw new Error('no fixture response');
    return new Response(response.body === undefined ? '' : JSON.stringify(response.body), { status: response.status ?? 200 });
  };
  return { calls, fetcher };
}
test('PKCE uses the RFC7636 challenge', () => assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'));
test('OAuth rejects wrong state, duplicate state and foreign origin', () => {
  for (const url of ['http://127.0.0.1:19428/callback?code=x&state=wrong', 'http://evil.example:19428/callback?code=x&state=expected', 'http://127.0.0.1:19428/callback?code=x&state=expected&state=expected']) assert.throws(() => authorizationCode(new URL(url), 'expected'));
  assert.equal(authorizationCode(new URL('http://127.0.0.1:19428/callback?code=x&state=expected'), 'expected'), 'x');
});
test('refresh token form escapes plus and preserves an unchanged refresh token', async () => {
  const fixture = transport([{ body: { access_token: 'new', expires_in: 3600 } }]);
  const refreshed = await refreshToken(token, fixture.fetcher); assert.equal(refreshed.refreshToken, 'a+b');
  assert.ok(String(fixture.calls[0]!.init!.body).includes('refresh_token=a%2Bb'));
});
test('loopback authorization validates callback then exchanges using PKCE', async () => {
  const fixture = transport([{ body: { access_token: 'new', refresh_token: 'refresh', expires_in: 3600 } }]);
  const login = new SpotifyLogin(fixture.fetcher);
  const result = await login.connect(token.clientID, async address => {
    const url = new URL(address); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const invalid = await fetch('http://127.0.0.1:19428/callback?code=x&state=invalid'); assert.equal(invalid.status, 400);
    const response = await fetch(`http://127.0.0.1:19428/callback?code=example&state=${url.searchParams.get('state')}`); assert.equal(response.status, 200);
  });
  assert.equal(result.accessToken, 'new'); assert.ok(String(fixture.calls[0]?.init?.body).includes('code_verifier='));
});
test('current Spotify generic library endpoint writes a URI query parameter', async () => {
  const fixture = transport([{ body: { id: 'abc123', name: 'Song', artists: [{ name: 'Artist' }], album: { name: 'Original Album', artists: [{ name: 'Artist' }], release_date: '2024-02-29' } } }, {}]), service = new SpotifyService(token, () => {}, fixture.fetcher);
  await service.setSaved(false, item('spotify', 'track', 'abc123'));
  const request = fixture.calls.at(-1)!; assert.equal(request.init?.method, 'DELETE'); assert.equal(new URL(request.url).pathname, '/v1/me/library'); assert.equal(new URL(request.url).searchParams.get('uris'), 'spotify:track:abc123');
});
test('Spotify write refuses a relinked or different release before changing favorites', async () => {
  const fixture = transport([{ body: { id: 'otherid', name: 'Song', artists: [{ name: 'Artist' }], album: { name: 'Greatest Hits', artists: [{ name: 'Artist' }], release_date: '2024-02-29' } } }]);
  await assert.rejects(new SpotifyService(token, () => {}, fixture.fetcher).setSaved(false, item('spotify', 'track', 'abc123'))); assert.equal(fixture.calls.length, 1);
});
test('foreign pagination host is rejected before credentials can be sent', async () => {
  const fixture = transport([{ body: { id: 'user' } }, { body: { items: [], next: 'https://evil.example/v1/page', total: 1 } }]);
  await assert.rejects(new SpotifyService(token, () => {}, fixture.fetcher).snapshot('track')); assert.equal(fixture.calls.length, 2);
});
test('failed pagination cannot yield a successful empty or partial scan', async () => {
  const fixture = transport([{ body: { id: 'user' } }, { body: { items: [{ track: { id: 'a', name: 'Song', artists: [{ name: 'Artist' }], album: { name: 'Album', artists: [{ name: 'Artist' }], release_date: '2024-01-01' } } }], next: 'https://api.spotify.com/v1/me/tracks?offset=1', total: 2 } }, { status: 429 }]);
  await assert.rejects(new SpotifyService(token, () => {}, fixture.fetcher).snapshot('track'), /限流/u);
});
test('Spotify accepts null optional release metadata without inventing dates, identifiers or track positions', async () => {
  for (const kind of ['track', 'album'] as const) {
    const entity = { id: 'valid123', name: 'Album', artists: [{ name: 'Artist' }], release_date: null,
      external_ids: { upc: null, isrc: null }, external_urls: null, disc_number: null, track_number: null, duration_ms: null,
      ...(kind === 'track' ? { album: { name: 'Album', artists: [{ name: 'Artist' }], release_date: null, external_ids: null } } : {}) };
    const fixture = transport([{ body: { id: 'user' } }, { body: { items: [{ [kind]: entity }], next: null, total: 1 } }]);
    const result = await new SpotifyService(token, () => {}, fixture.fetcher).snapshot(kind);
    assert.equal(result.isComplete, true); assert.deepEqual(result.savedIDs, ['valid123']);
    const value = result.items[0]!; assert.equal(value.release?.date, undefined); assert.equal(value.release?.barcode, undefined);
    assert.equal(value.isrc, undefined); assert.equal(value.trackNumber, undefined); assert.equal(value.durationMS, undefined);
  }
});
test('unavailable Spotify entries produce a partial snapshot and cannot imply cancellations', async () => {
  const fixture = transport([{ body: { id: 'user' } }, { body: { items: [
    { track: { id: 'readable123', name: 'Song', artists: [{ name: 'Artist' }], album: { name: 'Album', artists: [{ name: 'Artist' }], release_date: '2024-02' } } },
    { track: { id: { credential: 'private-cookie' }, name: 'private-title' } }, { track: null }
  ], next: null, total: 3 } }]);
  const result = await new SpotifyService(token, () => {}, fixture.fetcher).snapshot('track');
  assert.equal(result.isComplete, false); assert.deepEqual(result.savedIDs, ['readable123']);
  assert.match(result.notes.join(' '), /2 项/); assert.match(result.notes.join(' '), /第 2 项/);
  assert.doesNotMatch(result.notes.join(' '), /private-/); assert.equal(result.items[0]?.release?.date?.value, '2024-02');
  const a = item('spotify'), b = item('netease'), state = stateFor(mapping([a, b]), [snap(a, true, true, 'user'), snap(b, true)]);
  const plan = planSync(state, [result, snap(b, true)]);
  assert.equal(plan.operations.length, 0); assert.ok(plan.issues.some(issue => issue.message.includes('未读到可靠状态')));
});
test('all-unavailable Spotify records remain unknown rather than a complete empty list', async () => {
  const fixture = transport([{ body: { id: 'user' } }, { body: { items: [{ album: null }], next: null, total: 1 } }]);
  const result = await new SpotifyService(token, () => {}, fixture.fetcher).snapshot('album');
  assert.equal(result.isComplete, false); assert.deepEqual(result.items, []); assert.equal(result.notes.length, 1);
});
test('empty Spotify names stay unresolved and include an official item URL for manual checking', async () => {
  const fixture = transport([{ body: { id: 'user' } }, { body: { items: [
    { track: { id: 'empty123', name: '' } }, { track: { id: 'blank123', name: '   ' } }
  ], next: null, total: 2 } }]);
  const snapshot = await new SpotifyService(token, () => {}, fixture.fetcher).snapshot('track');
  assert.equal(snapshot.isComplete, false); assert.deepEqual(snapshot.items, []); assert.match(snapshot.notes.join(' '), /文本为空/);
  assert.match(snapshot.notes.join(' '), /https:\/\/open\.spotify\.com\/track\/empty123/);
});
test('Spotify relinked tracks and local files cannot masquerade as complete saved release state', async () => {
  const entity = { id: 'substitute123', name: 'Song', artists: [{ name: 'Artist' }], album: { name: 'Original Album', artists: [{ name: 'Artist' }], release_date: '2024-02-29' } };
  const fixture = transport([{ body: { id: 'user' } }, { body: { items: [
    { track: { ...entity, linked_from: { id: 'original123' } } }, { track: { ...entity, id: 'local123', is_local: true } }
  ], next: null, total: 2 } }]);
  const result = await new SpotifyService(token, () => {}, fixture.fetcher).snapshot('track');
  assert.equal(result.isComplete, false); assert.deepEqual(result.savedIDs, []); assert.match(result.notes.join(' '), /重定向/);
  const a = item('spotify', 'track', 'original123'), b = item('netease'), state = stateFor(mapping([a, b]), [snap(a, true, true, 'user'), snap(b, true)]);
  assert.equal(planSync(state, [result, snap(b, true)]).operations.length, 0);
});
test('malformed Spotify pages and non-JSON replies retain safe endpoint and field diagnostics', async () => {
  for (const page of [{ next: null, total: 0 }, { items: [], total: 0 }]) {
    const fixture = transport([{ body: { id: 'user' } }, { body: page }]);
    await assert.rejects(new SpotifyService(token, () => {}, fixture.fetcher).snapshot('track'), error => {
      assert.ok(error instanceof MSyncError); assert.match(error.message, /Spotify GET \/me\/tracks/);
      assert.match(error.message, /字段 (items|next)/); return true;
    });
  }
  let calls = 0;
  const invalidJSON: Fetcher = async () => ++calls === 1 ? new Response(JSON.stringify({ id: 'user' })) : new Response('<html>private-response</html>');
  await assert.rejects(new SpotifyService(token, () => {}, invalidJSON).snapshot('album'), error => {
    assert.ok(error instanceof MSyncError); assert.match(error.message, /Spotify GET \/me\/albums/);
    assert.match(error.message, /JSON/); assert.doesNotMatch(error.message, /private-/); return true;
  });
});
test('Spotify pagination still checks server totals even when entries are unreadable', async () => {
  const fixture = transport([{ body: { id: 'user' } }, { body: { items: [{ track: null }], next: null, total: 2 } }]);
  await assert.rejects(new SpotifyService(token, () => {}, fixture.fetcher).snapshot('track'), /收藏列表变化/);
});
test('Apple native scan exposes explicit false but never claims complete cloud coverage', () => {
  const scan = nativeSnapshot('track', 'library', [{ persistentID: '0123456789ABCDEF', title: 'Song', artist: 'Artist', album: 'Album', albumArtist: 'Artist', date: null, favorited: false, albumFavorited: false }]);
  assert.equal(scan.isComplete, false); assert.equal(scan.items.length, 1); assert.deepEqual(scan.savedIDs, []); assert.equal(scan.items[0]?.release?.date, undefined);
});
test('Apple native artist list remains explicitly unsupported', () => assert.throws(() => nativeSnapshot('artist', 'library', [])));
test('Apple links distinguish song context from album and reject foreign or malformed URLs', () => {
  assert.equal(appleCatalogID('https://music.apple.com/cn/album/example/123?i=456', 'track'), '456');
  assert.equal(appleCatalogID('https://music.apple.com/us/artist/example/123', 'artist'), '123');
  for (const url of ['https://evil.example/cn/album/example/123?i=456', 'javascript:alert(1)', 'https://music.apple.com/cn/album/example/123']) assert.throws(() => appleCatalogID(url, 'track'));
});
test('cross-platform Apple web confirmation is partial and cannot falsely acknowledge a remote write', async () => {
  const library = new ManualAppleLibrary(), value = item('appleMusic', 'track', 'web-track:456'); value.url = 'https://music.apple.com/cn/album/example/123?i=456';
  library.record(value, true); const service = new AppleWebService(library, 'manual-account');
  assert.equal((await service.snapshot('track')).isComplete, false); assert.equal((await service.setSaved(false, value)).applied, false);
  library.record(value, false); assert.deepEqual((await service.snapshot('track')).savedIDs, []);
});
