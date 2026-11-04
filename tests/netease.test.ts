import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execute, releaseDay, trackItem, type API } from "../src/adapters/netease-api.js";
import { NeteaseService } from "../src/adapters/netease.js";
import { MSyncError } from "../src/core/models.js";

function apiWith(methods: API = {}): API {
  return { login_status: async () => ({ body: { code: 200, data: { profile: { userId: 123 } } } }), ...methods };
}
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
  const api = apiWith({ login_status: async () => ({ body: { code: 200, data: {} } }) });
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
  const api = apiWith({ login_status: async () => ({ body: { code: 200, data: { account: { id: ++count } } } }),
    artist_sublist: async () => ({ body: { code: 200, data: [], count: 0 } }) });
  await assert.rejects(execute({ action: "snapshot", cookie: "test", kind: "artist" }, api));
});
