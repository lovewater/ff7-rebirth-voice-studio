/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { closestFallback } = require('./auto-run-fallback.ts');
const row = (id, overrides = {}) => ({ id, reviewed: true, hardIssueCount: 0,
  pronunciationIssueCount: 0, paceDeviation: 0, durationDeviation: 0, ...overrides });

test('fallback considers earlier rounds instead of taking the last failed clip', () => {
  assert.equal(closestFallback([row('round1', { hardIssueCount: 1 }),
    row('round2', { hardIssueCount: 3 }), row('round3', { hardIssueCount: 2 })]).id, 'round1');
});
test('complete text with bad pace wins over missing words at perfect pace', () => {
  assert.equal(closestFallback([row('missing', { hardIssueCount: 1 }),
    row('complete', { paceDeviation: .3, pronunciationIssueCount: 2 })]).id, 'complete');
});
test('equal hard issues compare pace then mild pronunciation then duration', () => {
  assert.equal(closestFallback([row('slow', { paceDeviation: .4 }),
    row('better', { paceDeviation: .2, pronunciationIssueCount: 2 }),
    row('best', { paceDeviation: .2, pronunciationIssueCount: 1, durationDeviation: .1 })]).id, 'best');
  assert.equal(closestFallback([row('long', { durationDeviation: 2 }), row('near')]).id, 'near');
});
test('unreviewed audio cannot look perfect and outrank reviewed evidence', () => {
  assert.equal(closestFallback([row('unknown', { reviewed: false }),
    row('reviewed', { hardIssueCount: 3 })]).id, 'reviewed');
});
test('unknown timing ranks after measured timing; ties keep earliest', () => {
  assert.equal(closestFallback([row('unknown', { paceDeviation: null }), row('known')]).id, 'known');
  assert.equal(closestFallback([row('first'), row('second')]).id, 'first');
});
test('service failure still retains generated audio even without any review', () => {
  assert.equal(closestFallback([row('audio', { reviewed: false, paceDeviation: null })]).id, 'audio');
  assert.equal(closestFallback([]), null);
});
