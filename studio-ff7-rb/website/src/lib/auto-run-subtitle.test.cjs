/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { autoRunSubtitle, twoLineSubtitle, subtitleRestorePlan, restorePerformanceSubtitle, retainedOhInterjection } = require('./auto-run-subtitle.ts');
test('BEG2000 compresses rewritten subtitle to balanced two lines without changing words', () => {
  const draft = '就像靠魔晄发家的神罗一样\n我们也要靠宝物\n干出一番大事业！';
  assert.equal(autoRunSubtitle(draft), '就像靠魔晄发家的神罗一样\n我们也要靠宝物，干出一番大事业！');
  assert.match(autoRunSubtitle(draft), /魔晄/);
  assert.equal(autoRunSubtitle(draft).split('\n').length, 2);
});
test('subtitle removes audio control markers while preserving text and punctuation', () => {
  assert.equal(autoRunSubtitle('  第一段[停顿=500]\\n第二段！  '), '第一段第二段！');
  assert.equal(autoRunSubtitle('甲\r\n乙'), '甲乙');
});
test('an empty rewrite cannot erase the final subtitle', () => {
  assert.throws(() => autoRunSubtitle(' [停顿=500] '), /不能为空/);
});

test('short subtitles merge; explicit and escaped line breaks share the rule', () => {
  assert.equal(twoLineSubtitle('一句话！'), '一句话！');
  assert.equal(twoLineSubtitle('甲\n乙。'), '甲乙。');
  assert.equal(twoLineSubtitle('甲甲甲\\n乙乙\\n丙丙\\n丁丁丁'), '甲甲甲乙乙丙丙丁丁丁');
});
test('existing punctuation is preserved without an extra comma', () => {
  assert.equal(twoLineSubtitle('甲甲甲甲\n乙，\n丙！'), '甲甲甲甲乙，丙！');
  assert.equal(twoLineSubtitle('甲甲甲甲\n乙……\n丙！'), '甲甲甲甲乙……丙！');
});
test('the retained newline is selected by character balance, including merges in the first line', () => {
  assert.equal(twoLineSubtitle('甲\n乙\n丙丙丙丙丙丙'), '甲乙丙丙丙丙丙丙');
});
test('formatting is idempotent and punctuation does not distort text length balance', () => {
  for (const input of ['甲甲！\n乙乙乙\n丙丙丙', '甲\n乙\n丙\n丁\n戊', '甲甲甲甲\r\n乙\r\n丙']) {
    const output = twoLineSubtitle(input);
    assert.equal(output.split('\n').length, [...input.replace(/\s/gu,'')].length < 14 ? 1 : 2);
    assert.equal(twoLineSubtitle(output), output);
    const letters = (s) => s.replace(/[\s\p{P}\p{S}]/gu, '');
    assert.equal(letters(output), letters(input));
  }
});

test('BUC3700 restores the original oh-oh before rewritten decoy speech', () => {
  const plan = subtitleRestorePlan('哦哦，诱饵吗！', '诱饵吗！');
  assert.deepEqual(plan.preserved, [{ at: 0, text: '哦哦，' }]);
  assert.equal(restorePerformanceSubtitle(plan, '诱饵！'), '哦哦，诱饵！');
  const edited = subtitleRestorePlan('哦！诱饵！', '诱饵！');
  assert.equal(restorePerformanceSubtitle(edited, '诱饵！'), '哦！诱饵！');
});
test('body-only child caption excludes laughter; final caption restores it before two-line formatting', () => {
  const plan = subtitleRestorePlan('咿嘻嘻嘻\n靠高价珍品开公司～！', '靠高价珍品开公司～！');
  const draft = '靠宝物\n开公司\n赚大钱！';
  assert.doesNotMatch(autoRunSubtitle(draft), /咿嘻/);
  const final = restorePerformanceSubtitle(plan, draft);
  assert.match(final, /^咿嘻嘻嘻/);
  assert.equal(final.split('\n').length, 2);
  assert.equal((final.match(/咿嘻嘻嘻/g) || []).length, 1);
});
test('middle laughter goes at an existing CN separator, not inside a word', () => {
  const plan = subtitleRestorePlan('甲甲，哈哈，乙乙！', '甲甲，乙乙！');
  assert.equal(restorePerformanceSubtitle(plan, '新甲甲，新乙乙！'), '新甲甲，哈哈，新乙乙！');
});
test('tail crying survives a rewrite without doubled punctuation', () => {
  const plan = subtitleRestorePlan('完蛋了，呜呜呜！', '完蛋了');
  assert.equal(restorePerformanceSubtitle(plan, '彻底完了！'), '彻底完了！呜呜呜！');
});
test('repeated workflow cleanup/restoration does not duplicate original effects', () => {
  const plan = subtitleRestorePlan('哦！诱饵！', '诱饵！');
  const full = restorePerformanceSubtitle(plan, '诱饵！');
  const nextPlan = subtitleRestorePlan(full, '诱饵！');
  assert.equal(restorePerformanceSubtitle(nextPlan, '诱饵！'), full);
});
test('punctuation-only cleanup adds no fictional effect words; invalid rewrites are rejected', () => {
  assert.deepEqual(subtitleRestorePlan('第一句，\n第二句！', '第一句第二句！').preserved, []);
  assert.throws(() => subtitleRestorePlan('哦哦，诱饵吗！', '完全不同！'), /删除结果/);
  assert.throws(() => subtitleRestorePlan('哦哦！', '！'), /正文没有/);
});

test('only independent matched oh/おお is forced to original audio, not a general lexical expression', () => {
  assert.deepEqual(retainedOhInterjection('おお', '哦哦，诱饵吗！'), { prefix: '哦哦，', body: '诱饵吗！' });
  assert.deepEqual(retainedOhInterjection('おお', '哦！诱饵！'), { prefix: '哦！', body: '诱饵！' });
  assert.equal(retainedOhInterjection('おおオトリか', '哦哦，诱饵吗！'), null);
  assert.equal(retainedOhInterjection('ええ', '是的，没错。'), null);
  assert.equal(retainedOhInterjection('おお', '诱饵！'), null);
});
