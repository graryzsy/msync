import test from "node:test";
import assert from "node:assert/strict";
import { execute, releaseDay, trackItem, type API } from "../src/adapters/netease-api.js";

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
test("account switch during scan aborts snapshot", async () => {
  let count = 0;
  const api = apiWith({ login_status: async () => ({ body: { code: 200, data: { account: { id: ++count } } } }),
    artist_sublist: async () => ({ body: { code: 200, data: [], count: 0 } }) });
  await assert.rejects(execute({ action: "snapshot", cookie: "test", kind: "artist" }, api));
});
