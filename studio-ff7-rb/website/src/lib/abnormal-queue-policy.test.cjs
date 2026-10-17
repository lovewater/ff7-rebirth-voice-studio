/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldAdvanceAbnormalQueue: next } = require('./abnormal-queue-policy.ts');
test('abnormal queue waits for lock and preserves in-progress edits even when earlier issues appear', () => {
  assert.equal(next('B', 'A', 'abnormal'), false);
  assert.equal(next('B', 'A', null), false);
  assert.equal(next('B', 'B', 'locked'), false);
  assert.equal(next('B', 'A', 'locked'), true);
  assert.equal(next('B', null, 'locked'), true);
  assert.equal(next(null, 'A', null), true);
  assert.equal(next(null, null, null), false);
});
