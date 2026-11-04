// Run without Next, network, model calls, or writes to user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ff7-rewrite-policy-'));
try {
  for (const name of ['beats', 'rewrite-prompt', 'subtitle-layout']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/lib', name + '.ts'), 'utf8');
    fs.writeFileSync(path.join(folder, name + '.js'), ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText);
  }
  const p = require(path.join(folder, 'rewrite-prompt.js'));
  for (const ratio of [0.9, 0.95, 1, 1.05, 1.1]) assert.equal(p.rewritePace(ratio), '正常');
  assert.equal(p.rewritePace(0.899), '偏快');
  assert.equal(p.rewritePace(1.101), '偏慢');
  const input = {
    attempt: 2, speaker: '角色', show: 'event', textJp: '長い日本語の台詞です', textEn: '',
    original: '第一行\n第二行', current: '第一行\n第二行', beats: {jp: {units: 20}, cn: {units: 15}},
    before: [], after: [], previous: [{raw: '{"text":"已有合格稿"}', units: 15}],
  };
  const messages = p.rewriteMessages(input);
  const text = messages.map(m => m.content).join('\n');
  assert.match(text, /第 3 轮/);
  assert.match(text, /0\.9 到 1\.1/);
  assert.match(text, /不用向 1\.00 靠拢/);
  assert.match(text, /保持 2 行/);
  assert.doesNotMatch(text, /0\.92|1\.08/);
  assert.equal(p.parseRewrite('{"text":"第一行\\n第二行"}').text, '第一行\n第二行');
  const context = p.takeUntilBoundary([{scene: 1}, {scene: 2}, {scene: 2}, {scene: 3}], 2, row => row.scene === 2);
  assert.deepEqual(context, {before: [{scene: 2}], after: []});
  const spokenFeedback = p.rewriteMessages({...input, previous: [{raw: '{}', units: 15, spokenUnits: 18}]});
  assert.match(spokenFeedback.at(-1).content, /实际朗读比/);
  assert.match(spokenFeedback.at(-1).content, /判定偏快/);
  assert.match(spokenFeedback.at(-1).content, /减少/);
  const layout = require(path.join(folder, 'subtitle-layout.js'));
  const long = '这是一段需要遵循原字幕行数的长字幕，不因为长度较长而额外分行。';
  assert.equal(layout.subtitleLayout(long, '原字幕只有一行'), long);
  assert.equal(layout.subtitleLayout('第一行\n第二行', '原文第一行\n原文第二行'), '第一行\n第二行');
  assert.throws(() => layout.subtitleLayout('第一行\n第二行', '原文只有一行'));
  assert.throws(() => layout.subtitleLayout(long, '原文第一行\n原文第二行'));
  console.log('Rewrite policy: inclusive range, third-round wording, newlines, and scene boundaries passed.');
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
