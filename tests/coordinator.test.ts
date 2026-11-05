import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../src/core/store.js';
import { SyncCoordinator } from '../src/core/coordinator.js';
import { MemoryService, item, mapping, snap } from './fixtures.js';
import { AppleNativeService } from '../src/adapters/apple-native.js';
import type { Kind } from '../src/core/models.js';

async function setup() {
  const store = await StateStore.open(), a = item('spotify'), b = item('netease'); store.addMapping(mapping([a, b]));
  const spotify = new MemoryService('spotify', a, true), netease = new MemoryService('netease', b, false);
  return { store, a, b, spotify, netease, services: [spotify, netease], coordinator: new SyncCoordinator(store) };
}
test('preview is read-only and apply confirms remote state without a feedback loop', async () => {
  const context = await setup(), plan = await context.coordinator.preview(context.services);
  assert.equal(context.netease.writes, 0); assert.equal(context.store.load().snapshots.length, 0);
  const report = await context.coordinator.apply(plan, context.services); assert.equal(report.applied, 1); assert.equal(report.pending.length, 0);
  assert.equal((await context.coordinator.preview(context.services)).operations.length, 0); assert.equal(context.store.load().outstanding.length, 0); context.store.close();
});
test('changed remote state after preview aborts before writing or accepting a baseline', async () => {
  const context = await setup(), plan = await context.coordinator.preview(context.services); context.spotify.change(context.a, false);
  await assert.rejects(context.coordinator.apply(plan, context.services)); assert.equal(context.netease.writes, 0); assert.equal(context.store.load().snapshots.length, 0); context.store.close();
});
test('failed write preserves durable intent and generates a retry', async () => {
  const context = await setup(); context.netease.fail = true;
  const report = await context.coordinator.apply(await context.coordinator.preview(context.services), context.services);
  assert.equal(report.applied, 0); assert.equal(report.pending.length, 1); assert.equal(context.store.load().outstanding.length, 1);
  assert.equal((await context.coordinator.preview(context.services)).operations.length, 1); context.store.close();
});
test('known native Apple artist limitations are scan notes rather than failed requests', async context => {
  const store = await StateStore.open(), apple = new AppleNativeService('/unused/script.js'), requested: Kind[] = [];
  context.mock.method(apple, 'snapshot', async (kind: Kind) => {
    requested.push(kind); if (kind === 'artist') throw new Error('unsupported kind must not be requested');
    const snapshot = snap(item('appleMusic', kind), true, false); snapshot.notes = ['仅确认本机资料库可读状态']; return snapshot;
  });
  try {
    const plan = await new SyncCoordinator(store).preview([apple]);
    assert.deepEqual(requested, ['track', 'album']); assert.equal(plan.issues.length, 0);
    assert.ok(plan.notes?.some(note => note.includes('艺人') && note.includes('网页确认')));
    assert.equal(plan.notes?.filter(note => note.includes('仅确认本机')).length, 1);
    assert.ok(plan.observations.every(snapshot => !snapshot.isComplete));
  } finally { store.close(); }
});
