import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../src/core/store.js';
import { planSync } from '../src/core/planner.js';
import { item, mapping, snap } from './fixtures.js';

test('SQLite persists mappings, pending operations and deletion tombstones across reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync persistence ')), path = join(directory, 'collections.sqlite');
  try {
    const store = await StateStore.open(path), a = item('spotify'), b = item('appleMusic');
    const link = mapping([a, b]); store.addMapping(link);
    store.begin(planSync(store.load(), [snap(a, true), snap(b, true)]));
    const plan = planSync(store.load(), [snap(a, true), snap(b, false)]); store.begin(plan); store.close();
    assert.equal(readFileSync(path).subarray(0, 16).toString(), 'SQLite format 3\0');
    const restored = await StateStore.open(path); assert.equal(restored.load().desired[link.id], false); assert.equal(restored.load().outstanding.length, 1); restored.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('preview does not advance baseline and stale commit is rejected', async () => {
  const store = await StateStore.open(), a = item('spotify'), b = item('appleMusic'); store.addMapping(mapping([a, b]));
  const plan = planSync(store.load(), [snap(a, true), snap(b, false)]); assert.equal(store.load().snapshots.length, 0);
  store.log('changed'); assert.throws(() => store.begin(plan)); assert.equal(store.load().snapshots.length, 0); store.close();
});
test('partial snapshot retains previously known explicit state', async () => {
  const store = await StateStore.open(), a = item('appleMusic');
  store.begin(planSync(store.load(), [snap(a, true)])); store.begin(planSync(store.load(), [snap(a, undefined)]));
  assert.deepEqual(store.load().snapshots[0]?.savedIDs, [a.id]); store.close();
});
test('pair can extend into a three-platform mapping without changing identity', async () => {
  const store = await StateStore.open(), link = mapping([item('spotify'), item('appleMusic')]); store.addMapping(link);
  store.addMapping(mapping([item('spotify'), item('netease')])); assert.equal(store.load().mappings.length, 1); assert.equal(store.load().mappings[0]?.id, link.id); assert.equal(store.load().mappings[0]?.items.length, 3); store.close();
});
test('multiple versions on one platform and incomplete or conflicting dates are rejected', async () => {
  const store = await StateStore.open(); store.addMapping(mapping([item('spotify'), item('appleMusic')]));
  assert.throws(() => store.addMapping(mapping([item('spotify'), item('appleMusic', 'track', 'other')])));
  const clean = await StateStore.open();
  assert.throws(() => clean.addMapping(mapping([item('spotify'), item('appleMusic', 'track', 'other', 'Original Album', '2024')])));
  assert.throws(() => clean.addMapping(mapping([item('spotify'), item('appleMusic', 'track', 'other', 'Greatest Hits')])));
  clean.close(); store.close();
});
test('changed account cannot silently replace acknowledged baseline', async () => {
  const store = await StateStore.open(), a = item('spotify'); store.begin(planSync(store.load(), [snap(a, true)]));
  assert.throws(() => store.begin(planSync(store.load(), [snap(a, false, true, 'other')]))); assert.equal(store.load().snapshots[0]?.accountID, 'account'); store.close();
});
test('acknowledgment does not swallow independent user changes', async () => {
  const store = await StateStore.open(), a = item('spotify'), second = item('spotify', 'track', 'second');
  const before = snap(a, true); before.items.push(second); before.savedIDs.push(second.id);
  const operation = { id: randomUUID(), mappingID: randomUUID(), item: a, saved: false, reason: 'remove' };
  const plan = { ...planSync(store.load(), [before]), operations: [operation] }; store.begin(plan);
  const confirmation = structuredClone(before); confirmation.savedIDs = [];
  store.acknowledge(operation, plan.id, confirmation); assert.deepEqual(store.load().snapshots[0]?.savedIDs, [second.id]); store.close();
});
test('second process cannot overwrite an externally changed database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync writers ')), path = join(directory, 'collections.sqlite');
  try {
    const a = await StateStore.open(path), b = await StateStore.open(path);
    a.log('first writer'); assert.throws(() => b.log('second writer')); assert.equal(b.load().revision, 0);
    a.close(); b.close(); const restored = await StateStore.open(path); assert.equal(restored.load().audit[0]?.message, 'first writer'); restored.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('corrupt database and active WAL are preserved and rejected', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'msync invalid ')), path = join(directory, 'collections.sqlite');
  try {
    writeFileSync(path, 'invalid'); await assert.rejects(StateStore.open(path)); assert.equal(readFileSync(path, 'utf8'), 'invalid');
    writeFileSync(`${path}-wal`, 'pending'); await assert.rejects(StateStore.open(path));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('backup import cannot bypass strict release validation or replay old pending writes', async () => {
  const store = await StateStore.open(), a = item('spotify'), b = item('appleMusic'); store.addMapping(mapping([a, b]));
  const before = store.load(), invalid = structuredClone(before); invalid.mappings[0]!.items[1]!.release!.title = 'Greatest Hits';
  assert.throws(() => store.importState(invalid)); assert.deepEqual(store.load(), before);
  const imported = structuredClone(before); imported.outstanding = [{ id: randomUUID(), mappingID: before.mappings[0]!.id, item: a, saved: false, reason: 'old pending' }];
  store.importState(imported); assert.equal(store.load().outstanding.length, 0); assert.equal(store.load().mappings.length, 1); store.close();
});
