/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ttsVersionForest } = require('./tts-version-tree.ts');
const row = (id, parent = null) => ({ id, parent_tts_id: parent });
const ids = (nodes) => nodes.map((node) => node.record.id);
test('requested example groups exactly three children under 38974 and keeps 38975 independent', () => {
  const forest = ttsVersionForest([row('38975'), row('38974'), row('38973','38974'), row('38972','38974'), row('38971','38974')]);
  assert.deepEqual(ids(forest), ['38975','38974']);
  assert.deepEqual(ids(forest[1].children), ['38973','38972','38971']);
});
test('chosen earlier candidate remains root even when newer siblings precede it', () => {
  const forest = ttsVersionForest([row('30','28'),row('29','28'),row('28')]);
  assert.deepEqual(ids(forest), ['28']);
  assert.deepEqual(ids(forest[0].children), ['30','29']);
});
test('missing/deleted/unready parent promotes children without losing records', () => {
  assert.deepEqual(ids(ttsVersionForest([row('2','1'),row('3','1')])), ['2','3']);
});
test('multiple workflows stay separate; manual records stay at top level', () => {
  const forest = ttsVersionForest([row('6'),row('5'),row('4','5'),row('3'),row('2','3')]);
  assert.deepEqual(ids(forest), ['6','5','3']);
  assert.deepEqual(ids(forest[1].children), ['4']);
  assert.deepEqual(ids(forest[2].children), ['2']);
});
test('cycles, self references and legacy rows remain visible', () => {
  const forest = ttsVersionForest([row('1','2'),row('2','1'),row('3','3'),{id:'4'}]);
  assert.deepEqual(ids(forest), ['1','2','3','4']);
});
test('default subtitle/edit target is final output even if a child has a newer ID; explicit locks still win', () => {
  const { preferredTtsVersion } = require('./tts-version-tree.ts');
  const rows = [row('30','28'),row('29','28'),row('28')].map((r) => ({...r,status:'ready',is_used:false}));
  assert.equal(preferredTtsVersion(rows).id,'28');
  rows[0].is_used=true;
  assert.equal(preferredTtsVersion(rows).id,'30');
});
