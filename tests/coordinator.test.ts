import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../src/core/store.js';
import { SyncCoordinator } from '../src/core/coordinator.js';
import { MemoryService, item, mapping } from './fixtures.js';

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
