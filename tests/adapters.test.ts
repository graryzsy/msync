import test from 'node:test';
import assert from 'node:assert/strict';
import { pkceChallenge, authorizationCode, refreshToken, SpotifyLogin, type SpotifyToken } from '../src/adapters/spotify-oauth.js';
import { SpotifyService } from '../src/adapters/spotify.js';
import type { Fetcher } from '../src/adapters/http.js';
import { nativeSnapshot } from '../src/adapters/apple-native.js';
import { AppleWebService, appleCatalogID, ManualAppleLibrary } from '../src/adapters/apple-web.js';
import { item } from './fixtures.js';

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
