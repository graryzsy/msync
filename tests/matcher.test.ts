import test from 'node:test';
import assert from 'node:assert/strict';
import { assess, exactDate, normalize } from '../src/core/matcher.js';
import { item } from './fixtures.js';

test('exact calendar dates retain precision and reject invented or invalid days', () => {
  assert.equal(exactDate('2024-02-29'), true);
  for (const value of ['2023-02-29', '2024', '2024-02', '2024-13-01', '2024-04-31', '2024-1-01', '+024-01-01', '0000-01-01']) assert.equal(exactDate(value), false, value);
});
test('same ISRC on a compilation is a different release', () => assert.equal(assess(item('spotify'), item('netease', 'track', 'other', 'Greatest Hits')).decision, 'different'));
test('single and album releases remain separate', () => assert.equal(assess(item('spotify', 'track', 'a', 'Song - Single'), item('appleMusic')).decision, 'different'));
test('deluxe edition markers are retained', () => assert.equal(assess(item('spotify'), item('appleMusic', 'track', 'b', 'Original Album (Deluxe)')).decision, 'different'));
test('one-day difference is never tolerated', () => assert.equal(assess(item('spotify'), item('appleMusic', 'track', 'b', 'Original Album', '2024-03-01')).decision, 'different'));
test('missing day requires review', () => assert.equal(assess(item('spotify'), item('appleMusic', 'track', 'b', 'Original Album', '2024')).decision, 'needsReview'));
test('matching edition is only compatible, not automatically verified', () => assert.equal(assess(item('spotify'), item('appleMusic')).decision, 'compatible'));
test('same-named artists require identity confirmation', () => assert.equal(assess(item('spotify', 'artist'), item('netease', 'artist')).decision, 'needsReview'));
test('title difference cannot hide a hard release conflict', () => {
  const other = item('netease', 'track', 'b', 'Greatest Hits'); other.title = 'Translated';
  assert.equal(assess(item('spotify'), other).decision, 'different');
});
test('different ISRC or position cannot match', () => {
  const other = item('appleMusic'); other.isrc = 'OTHER'; assert.equal(assess(item('spotify'), other).decision, 'different');
  other.isrc = 'USABC0000001'; other.trackNumber = 3; assert.equal(assess(item('spotify'), other).decision, 'different');
});
test('normalization handles width/case/space without stripping version text', () => {
  assert.equal(normalize('  ＳＯＮＧ   Live '), 'song live');
  assert.notEqual(normalize('Album (Deluxe)'), normalize('Album'));
});
