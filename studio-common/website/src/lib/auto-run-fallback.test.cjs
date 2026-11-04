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
test('equal hard issues compare measured duration first, pronunciation only breaks timing ties', () => {
  assert.equal(closestFallback([row('far', { durationDeviation: .4 }),
    row('better', { durationDeviation: .2, pronunciationIssueCount: 2 }),
    row('best', { durationDeviation: .2, pronunciationIssueCount: 1 })]).id, 'best');
  assert.equal(closestFallback([row('long', { durationDeviation: 2 }), row('near')]).id, 'near');
});
test('unreviewed audio cannot look perfect and outrank reviewed evidence', () => {
  assert.equal(closestFallback([row('unknown', { reviewed: false }),
    row('reviewed', { hardIssueCount: 3 })]).id, 'reviewed');
});
test('unknown timing ranks after measured timing; ties keep earliest', () => {
  assert.equal(closestFallback([row('unknown', { durationDeviation: null }), row('known')]).id, 'known');
  assert.equal(closestFallback([row('first'), row('second')]).id, 'first');
});
test('beat ratio and net-duration ratio do not penalize fallback time selection; exemptions remain independent',()=>{
 const near=row('near',{durationDeviation:.02,paceDeviation:.9,beatDeviation:2,characterDeviation:5,pronunciationIssueCount:2});
 const far=row('far',{durationDeviation:.3,paceDeviation:0,beatDeviation:0});
 assert.equal(closestFallback([far,near]).id,'near');
 assert.equal(closestFallback([far,{...near,beatDeviation:null,paceDeviation:null}]).id,'near');
});
test('NaN timing never wins over measured timing',()=>{
 assert.equal(closestFallback([row('unknown',{durationDeviation:NaN}),row('known',{durationDeviation:1})]).id,'known');
});
test('service failure still retains generated audio even without any review', () => {
  assert.equal(closestFallback([row('audio', { reviewed: false, paceDeviation: null })]).id, 'audio');
  assert.equal(closestFallback([]), null);
});
