import test from 'node:test';
import assert from 'node:assert/strict';
import { planSync } from '../src/core/planner.js';
import { emptyState, platforms } from '../src/core/models.js';
import { item, items, mapping, snap, stateFor } from './fixtures.js';

test('Apple Music removal propagates to Spotify and NetEase', () => {
  const values = items(), link = mapping(values), state = stateFor(link, values.map(value => snap(value, true)));
  const plan = planSync(state, values.map(value => snap(value, value.platform !== 'appleMusic')));
  assert.deepEqual(plan.operations.map(operation => operation.item.platform), ['spotify', 'netease']);
  assert.ok(plan.operations.every(operation => !operation.saved));
});
test('initial absence does not delete the Spotify anchor', () => {
  const values = items(), plan = planSync(stateFor(mapping(values)), values.map(value => snap(value, value.platform === 'spotify')));
  assert.equal(plan.operations.length, 2); assert.ok(plan.operations.every(operation => operation.saved));
});
test('unknown absence cannot produce a deletion', () => {
  const values = items(), state = stateFor(mapping(values), values.map(value => snap(value, true)));
  const plan = planSync(state, values.map(value => snap(value, value.platform === 'appleMusic' ? undefined : true)));
  assert.equal(plan.operations.length, 0); assert.ok(plan.issues.length);
});
test('explicit false in partial scan can propagate', () => {
  const values = items(), state = stateFor(mapping(values), values.map(value => snap(value, true)));
  const plan = planSync(state, values.map(value => snap(value, value.platform !== 'appleMusic', false)));
  assert.equal(plan.operations.length, 2); assert.ok(plan.operations.every(operation => !operation.saved));
});
test('offline platform cannot resurrect a recorded removal', () => {
  const values = items(), link = mapping(values), snapshots = values.map(value => snap(value, value.platform === 'netease'));
  const state = stateFor(link, snapshots); state.desired[link.id] = false;
  const plan = planSync(state, snapshots);
  assert.equal(plan.operations.length, 1); assert.equal(plan.operations[0]?.item.platform, 'netease'); assert.equal(plan.operations[0]?.saved, false);
});
test('later explicitly observed addition restores collection', () => {
  const values = items(), link = mapping(values), state = stateFor(link, values.map(value => snap(value, false))); state.desired[link.id] = false;
  const plan = planSync(state, values.map(value => snap(value, value.platform === 'netease')));
  assert.equal(plan.operations.length, 2); assert.ok(plan.operations.every(operation => operation.saved));
});
test('account switch blocks entire mapping', () => {
  const values = items(), state = stateFor(mapping(values), values.map(value => snap(value, true)));
  const plan = planSync(state, values.map(value => snap(value, false, true, value.platform === 'appleMusic' ? 'other' : 'account')));
  assert.equal(plan.operations.length, 0); assert.ok(plan.issues.some(issue => issue.message.includes('账户')));
});
test('Spotify wins conflicting changes only when it actually changed', () => {
  const values = items(), state = stateFor(mapping(values), values.map(value => snap(value, value.platform !== 'spotify')));
  const plan = planSync(state, values.map(value => snap(value, value.platform !== 'netease')));
  assert.deepEqual(plan.operations.map(operation => [operation.item.platform, operation.saved]), [['netease', true]]);
});
test('conflicting secondary changes require review instead of passive Spotify override', () => {
  const values = items(), state = stateFor(mapping(values), values.map(value => snap(value, value.platform !== 'appleMusic')));
  const plan = planSync(state, values.map(value => snap(value, value.platform !== 'netease')));
  assert.equal(plan.operations.length, 0); assert.ok(plan.issues.some(issue => issue.message.includes('相反')));
});
test('unverified and multiply mapped items never write', () => {
  const values = items(), link = mapping(values); link.verified = false;
  assert.equal(planSync(stateFor(link), values.map(value => snap(value, value.platform === 'spotify'))).operations.length, 0);
  const state = { ...emptyState(), mappings: [mapping(values), mapping(values)] };
  assert.equal(planSync(state, values.map(value => snap(value, value.platform === 'spotify'))).operations.length, 0);
});
test('album cancellation does not cancel independently liked tracks', () => {
  const tracks = items(), albums = platforms.map(platform => item(platform, 'album'));
  const state = { ...emptyState(), mappings: [mapping(tracks), mapping(albums)], snapshots: [...tracks, ...albums].map(value => snap(value, true)) };
  const plan = planSync(state, [...tracks, ...albums].map(value => snap(value, !(value.kind === 'album' && value.platform === 'appleMusic'))));
  assert.equal(plan.operations.length, 2); assert.ok(plan.operations.every(operation => operation.item.kind === 'album'));
});
test('planning leaves input state unchanged', () => {
  const values = items(), state = stateFor(mapping(values)), before = structuredClone(state);
  planSync(state, values.map(value => snap(value, true))); assert.deepEqual(state, before);
});
test('changed release metadata blocks propagation even when the provider item ID is unchanged', () => {
  const values = items(), state = stateFor(mapping(values), values.map(value => snap(value, true)));
  const current = values.map(value => snap(value, value.platform !== 'appleMusic'));
  current[1]!.items[0]!.release!.title = 'Greatest Hits';
  const plan = planSync(state, current); assert.equal(plan.operations.length, 0); assert.ok(plan.issues.some(issue => issue.message.includes('发行元数据')));
});
