import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execute, releaseDay, trackItem, type API } from "../src/adapters/netease-api.js";
import { NeteaseService } from "../src/adapters/netease.js";
import { MSyncError } from "../src/core/models.js";
import { createNeteaseContext } from '../src/adapters/netease-context.js';
import { assess } from '../src/core/matcher.js';
import { item } from './fixtures.js';

function apiWith(methods: API = {}): API {
  return { login_status: async () => ({ body: { data: { code: 200, profile: { userId: 123 } } } }), ...methods };
}
test('the real login_status component wrapper permits all three collection scans', async () => {
  const loginStatus = createRequire(import.meta.url)('@neteasecloudmusicapienhanced/api/module/login_status.js');
  let statusRequests = 0;
  const api = apiWith({
    login_status: params => loginStatus(params, async (path: string, _data: unknown, options: { cookie: string }) => {
      statusRequests++; assert.equal(path, '/api/w/nuser/account/get'); assert.equal(options.cookie, 'fixture-cookie');
      return { status: 200, body: { code: 200, profile: { userId: 123 } }, cookie: [] };
    }),
    likelist: async () => ({ body: { code: 200, ids: [] } }),
    album_sublist: async () => ({ body: { code: 200, data: [], count: 0 } }),
    artist_sublist: async () => ({ body: { code: 200, data: [], count: 0 } })
  });
  const service = new NeteaseService('fixture-cookie', api);
  for (const kind of ['track', 'album', 'artist'] as const) {
    const result = await service.snapshot(kind);
    assert.equal(result.accountID, '123'); assert.equal(result.isComplete, true); assert.deepEqual(result.savedIDs, []);
  }
  assert.equal(statusRequests, 6);
});
test('expired or malformed login status never reaches collection endpoints or becomes an empty collection', async () => {
  for (const body of [{ code: 301 }, { data: { code: 301, profile: { userId: 123 } } }, { data: {} }, { data: { code: 200, profile: null, account: null } }]) {
    let collectionRequests = 0;
    const api = apiWith({ login_status: async () => ({ body }), likelist: async () => { collectionRequests++; return { body: { code: 200, ids: [] } }; } });
    await assert.rejects(new NeteaseService('fixture-cookie', api).snapshot('track'), error => {
      assert.ok(error instanceof MSyncError); assert.match(error.message, /login_status/); return true;
    });
    assert.equal(collectionRequests, 0);
  }
});
test('failed collection calls identify their endpoint and status without exposing the returned body', async () => {
  const api = apiWith({ album_sublist: async () => ({ body: { code: 460, message: 'private-response', cookie: 'private-cookie' } }) });
  await assert.rejects(new NeteaseService('fixture-cookie', api).snapshot('album'), error => {
    assert.ok(error instanceof MSyncError); assert.match(error.message, /album_sublist/); assert.match(error.message, /代码 460/);
    assert.doesNotMatch(error.message, /private-/); return true;
  });
});
test('album 405 preserves known favorites, leaves release dates unknown and pauses detail lookups across collections', async () => {
  let now = 0, albumRequests = 0, detailAllowed = false;
  const context = createNeteaseContext({ now: () => now });
  const api = apiWith({
    likelist: async () => ({ body: { code: 200, ids: [1, 2] } }),
    song_detail: async () => ({ body: { code: 200, songs: [1, 2].map(id => ({ id, name: `Song ${id}`, ar: [{ name: 'Performer' }],
      al: { id: 42, name: 'Original Album' }, publishTime: Date.parse('1999-01-01T00:00:00Z') })) } }),
    album_sublist: async () => ({ body: { code: 200, data: [{ id: 43, name: 'Another Album', artists: [{ name: 'Album Artist' }] }], count: 1 } }),
    album: async params => {
      albumRequests++;
      return { body: detailAllowed ? { code: 200, album: { id: params.id, name: 'Another Album', artists: [{ name: 'Album Artist' }], publishTime: Date.parse('2024-02-29T00:00:00Z') } }
        : { code: 405, message: 'private-response', cookie: 'private-cookie' } };
    }
  });
  const service = new NeteaseService('fixture', api, context);
  const tracks = await service.snapshot('track'), albums = await service.snapshot('album');
  assert.deepEqual(tracks.savedIDs, ['1', '2']); assert.deepEqual(albums.savedIDs, ['43']);
  assert.equal(tracks.isComplete, true); assert.equal(albums.isComplete, true);
  assert.equal(tracks.items[0]?.release?.date, undefined); assert.deepEqual(tracks.items[0]?.release?.artists, []);
  assert.equal(assess(item('spotify'), tracks.items[0]!).decision, 'needsReview');
  assert.match(tracks.notes.join(' '), /代码 405/); assert.match(albums.notes.join(' '), /5 分钟/);
  assert.doesNotMatch(tracks.notes.join(' '), /private-/); assert.equal(albumRequests, 1);
  now += 5 * 60_000 + 1; detailAllowed = true;
  const recovered = await service.snapshot('album');
  assert.equal(albumRequests, 2); assert.equal(recovered.items[0]?.release?.date?.value, '2024-02-29'); assert.deepEqual(recovered.notes, []);
});
test('album collection metadata avoids detail requests when the release is already complete', async () => {
  let detailRequests = 0;
  const api = apiWith({
    album_sublist: async () => ({ body: { code: 200, data: [{ id: 42, name: 'Original Album', artists: [{ name: 'Artist' }], publishTime: Date.parse('2024-02-29T00:00:00Z') }], count: 1 } }),
    album: async () => { detailRequests++; throw new Error('unnecessary detail request'); }
  });
  const snapshot = await new NeteaseService('fixture', api, createNeteaseContext()).snapshot('album');
  assert.equal(detailRequests, 0); assert.equal(snapshot.items[0]?.release?.date?.value, '2024-02-29'); assert.deepEqual(snapshot.notes, []);
});
test('release metadata cache spans scans while favorites are fetched fresh and cache entries expire', async () => {
  let now = 0, albumRequests = 0, favoriteRequests = 0, liked = true;
  const context = createNeteaseContext({ now: () => now });
  const api = apiWith({
    likelist: async () => { favoriteRequests++; return { body: { code: 200, ids: liked ? [1] : [] } }; },
    song_detail: async () => ({ body: { code: 200, songs: [{ id: 1, name: 'Song', ar: [{ name: 'Artist' }], al: { id: 42, name: 'Original Album' } }] } }),
    album_sublist: async () => ({ body: { code: 200, data: [{ id: 42, name: 'Original Album' }], count: 1 } }),
    album: async () => { albumRequests++; return { body: { code: 200, album: { id: 42, name: 'Original Album', artists: [{ name: 'Artist' }], publishTime: Date.parse('2024-02-29T00:00:00Z') } } }; }
  });
  const service = new NeteaseService('fixture', api, context);
  assert.deepEqual((await service.snapshot('track')).savedIDs, ['1']);
  assert.equal((await service.snapshot('album')).items[0]?.release?.date?.value, '2024-02-29'); assert.equal(albumRequests, 1);
  liked = false; assert.deepEqual((await service.snapshot('track')).savedIDs, []); assert.equal(favoriteRequests, 2);
  liked = true; now = 14 * 60_000; await service.snapshot('track'); assert.equal(albumRequests, 1);
  now = 16 * 60_000; await service.snapshot('track'); assert.equal(albumRequests, 2);
});
test('new service instances share metadata only for the same API and credentials', async () => {
  let albumRequests = 0;
  const api = apiWith({
    album_sublist: async () => ({ body: { code: 200, data: [{ id: 42, name: 'Original Album' }], count: 1 } }),
    album: async () => { albumRequests++; return { body: { code: 200, album: { id: 42, name: 'Original Album', artists: [{ name: 'Artist' }], publishTime: Date.parse('2024-02-29T00:00:00Z') } } }; }
  });
  await new NeteaseService('first-cookie-fixture', api).snapshot('album');
  await new NeteaseService('first-cookie-fixture', api).snapshot('album'); assert.equal(albumRequests, 1);
  await new NeteaseService('second-cookie-fixture', api).snapshot('album'); assert.equal(albumRequests, 2);
});
test('missing detail fields retain independently returned album metadata without substituting song dates', async () => {
  const api = apiWith({
    album_sublist: async () => ({ body: { code: 200, data: [{ id: 42, name: 'Original Album', publishTime: Date.parse('2024-02-29T00:00:00Z') }], count: 1 } }),
    album: async () => ({ body: { code: 200, album: { id: 42, artists: [{ name: 'Artist' }] } } })
  });
  const snapshot = await new NeteaseService('fixture', api, createNeteaseContext()).snapshot('album');
  assert.equal(snapshot.items[0]?.title, 'Original Album'); assert.equal(snapshot.items[0]?.release?.date?.value, '2024-02-29');
  assert.deepEqual(snapshot.items[0]?.artists, ['Artist']); assert.deepEqual(snapshot.notes, []);
});
test('conflicting album details cannot replace the collection release', async () => {
  for (const detail of [{ id: 99, name: 'Original Album' }, { id: 42, name: 'Greatest Hits' }]) {
    const api = apiWith({
      album_sublist: async () => ({ body: { code: 200, data: [{ id: 42, name: 'Original Album', artists: [{ name: 'Artist' }] }], count: 1 } }),
      album: async () => ({ body: { code: 200, album: { ...detail, artists: [{ name: 'Artist' }], publishTime: Date.parse('2024-02-29T00:00:00Z') } } })
    });
    const snapshot = await new NeteaseService('fixture', api, createNeteaseContext()).snapshot('album');
    assert.equal(snapshot.items[0]?.id, '42'); assert.equal(snapshot.items[0]?.release?.title, 'Original Album');
    assert.equal(snapshot.items[0]?.release?.date, undefined); assert.ok(snapshot.notes.length);
  }
});
test('authentication or membership failures remain fatal even when metadata can be read partially', async () => {
  for (const endpoint of ['album', 'album_sublist']) {
    const api = apiWith({
      album_sublist: async () => ({ body: endpoint === 'album_sublist' ? { code: 405 } : { code: 200, data: [{ id: 42, name: 'Original Album' }], count: 1 } }),
      album: async () => ({ body: { code: 301 } })
    });
    await assert.rejects(new NeteaseService('fixture', api, createNeteaseContext()).snapshot('album'), error => {
      assert.ok(error instanceof MSyncError); assert.match(error.message, endpoint === 'album' ? /登录已过期/ : /album_sublist/); return true;
    });
  }
});
test('request pacing spans collection kinds without waiting on wall-clock time in tests', async () => {
  let now = 0;
  const starts: number[] = [];
  const context = createNeteaseContext({ now: () => now, pause: async ms => { now += ms; }, minIntervalMS: 250 });
  const api = apiWith({
    login_status: async () => { starts.push(now); return { body: { data: { code: 200, profile: { userId: 123 } } } }; },
    artist_sublist: async () => { starts.push(now); return { body: { code: 200, data: [], count: 0 } }; },
    likelist: async () => { starts.push(now); return { body: { code: 200, ids: [] } }; }
  });
  const service = new NeteaseService('fixture', api, context);
  await service.snapshot('artist'); await service.snapshot('track');
  assert.deepEqual(starts, [0, 250, 500, 750, 1000, 1250]);
});
test("release dates retain NetEase calendar day, missing dates remain missing", () => {
  assert.equal(releaseDay(Date.parse("2024-02-28T16:00:00Z")), "2024-02-29");
  assert.equal(releaseDay(0), undefined);
  assert.equal(releaseDay(undefined), undefined);
});
test("track identity uses the containing release date rather than the song's original date", () => {
  const item = trackItem({ id: 1, name: "Song", ar: [{ name: "Artist" }], publishTime: 1 },
    { id: 2, name: "Compilation", artists: [{ name: "Artist" }], publishTime: Date.parse("2024-05-01T00:00:00Z") });
  assert.equal(item.release.title, "Compilation");
  assert.equal(item.release.date.value, "2024-05-01");
});
test("an incomplete song-detail response fails instead of publishing a shorter favorites list", async () => {
  const api = apiWith({ likelist: async () => ({ body: { code: 200, ids: [1, 2] } }), song_detail: async () => ({ body: { code: 200, songs: [] } }) });
  await assert.rejects(execute({ action: "snapshot", cookie: "test", kind: "track" }, api));
});
test("expired login cannot become an empty snapshot", async () => {
  const api = apiWith({ login_status: async () => ({ body: { data: { code: 200 } } }) });
  await assert.rejects(execute({ action: "snapshot", cookie: "expired", kind: "track" }, api));
});
test("writes use native album collection endpoint with explicit removal", async () => {
  const calls: Record<string, unknown>[] = [];
  const api = apiWith({ album_sub: async params => { calls.push(params); return { body: { code: 200 } }; } });
  assert.deepEqual(await execute({ action: "write", cookie: "test", kind: "album", id: "42", saved: false }, api), { applied: true });
  assert.equal(calls[0]?.t, 0);
});
test("empty artist collection is valid only after authenticated complete response", async () => {
  const api = apiWith({ artist_sublist: async () => ({ body: { code: 200, count: 0, data: [], hasMore: false } }) });
  const snapshot = await execute({ action: "snapshot", cookie: "test", kind: "artist" }, api) as Record<string, any>;
  assert.equal(snapshot.accountID, "123");
  assert.equal(snapshot.isComplete, true);
  assert.deepEqual(snapshot.savedIDs, []);
});
test("QR statuses remain distinct from HTTP/API success codes", async () => {
  const api = apiWith({ login_qr_check: async () => ({ body: { code: 801 } }) });
  assert.deepEqual(await execute({ action: "qrCheck", key: "test" }, api), { code: 801 });
});
test('QR login produces the component web login URL with chainId, without contacting an account', async () => {
  const createQR: NonNullable<API[string]> = createRequire(import.meta.url)('@neteasecloudmusicapienhanced/api/module/login_qr_create.js');
  let address = '';
  const api = apiWith({
    login_qr_key: async () => ({ body: { code: 200, data: { code: 200, unikey: 'offline-test-key' } } }),
    login_qr_create: async params => { const result = await createQR(params); address = result.body.data.qrurl; return result; }
  });
  const result = await execute({ action: 'qrStart' }, api) as { key: string; image: string };
  const url = new URL(address);
  assert.equal(url.origin, 'https://music.163.com');
  assert.equal(url.pathname, '/login');
  assert.equal(url.searchParams.get('codekey'), result.key);
  assert.match(url.searchParams.get('chainId') ?? '', /^v1_.+_web_login_\d+$/);
  assert.ok(result.image.startsWith('data:image/png;base64,'));
});
test('a rejected QR key stops login before creating an image or retrying', async () => {
  let keyCalls = 0, createCalls = 0;
  const api = apiWith({
    login_qr_key: async () => { keyCalls++; return { body: { code: 200, data: { code: 405, unikey: 'must-not-be-used' } } }; },
    login_qr_create: async () => { createCalls++; return { body: {} }; }
  });
  await assert.rejects(execute({ action: 'qrStart' }, api), /代码 405/);
  assert.equal(keyCalls, 1); assert.equal(createCalls, 0);
});
test('QR expiry, scan, confirmation and success states are preserved', async () => {
  for (const code of [800, 801, 802, 803]) {
    const api = apiWith({ login_qr_check: async () => ({ body: { code, cookie: 'fixture-cookie' } }) });
    assert.deepEqual(await execute({ action: 'qrCheck', key: 'test' }, api), { code, ...(code === 803 ? { cookie: 'fixture-cookie' } : {}) });
  }
});
test('login rejection reaches the desktop with a safe code and guidance, without raw response secrets or retries', async () => {
  for (const rejectedPromise of [false, true]) {
    let calls = 0;
    const api = apiWith({ login_qr_check: async () => {
      calls++;
      const response = { body: { code: 405, message: 'private-response-detail', cookie: 'private-cookie-fixture' } };
      if (rejectedPromise) throw response;
      return response;
    } });
    await assert.rejects(NeteaseService.invoke({ action: 'qrCheck', key: 'test' }, api), error => {
      assert.ok(error instanceof MSyncError);
      assert.match(error.message, /代码 405/); assert.match(error.message, /设备环境异常/);
      assert.doesNotMatch(error.message, /private-/); return true;
    });
    assert.equal(calls, 1);
  }
});
test('network failure does not expose the exception or instruct repeated QR generation', async () => {
  const api = apiWith({ login_qr_check: async () => { throw new Error('private-cookie-fixture'); } });
  await assert.rejects(NeteaseService.invoke({ action: 'qrCheck', key: 'test' }, api), error => {
    assert.ok(error instanceof MSyncError); assert.match(error.message, /网络/);
    assert.doesNotMatch(error.message, /private-|重新生成/); return true;
  });
});
test("account switch during scan aborts snapshot", async () => {
  let count = 0;
  const api = apiWith({ login_status: async () => ({ body: { data: { code: 200, account: { id: ++count } } } }),
    artist_sublist: async () => ({ body: { code: 200, data: [], count: 0 } }) });
  await assert.rejects(execute({ action: "snapshot", cookie: "test", kind: "artist" }, api));
});
