/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const fixtures = require('./auto-run-subtitle-cases.json');
const { autoRunSubtitle, needsSubtitleLineBreak, validateSubtitleLineBreak } = require('./auto-run-subtitle.ts');
for (const fixture of fixtures) test(`字幕小测试集：${fixture.name}`, () => {
  const text = autoRunSubtitle(fixture.input);
  if (fixture.model) {
    assert.equal(needsSubtitleLineBreak(text), true);
    assert.equal(text.split('\n').length,1);
  } else {
    assert.equal(text, fixture.expected);
    assert.equal(needsSubtitleLineBreak(text),false);
    assert.equal(autoRunSubtitle(text),text);
  }
});
function formatter(reply) {
  let calls=0;
  const mod=new Module(__filename);
  mod.require=id=>id==='./auto-run-llm'?{
    parseJsonObject:JSON.parse,
    rewriteChat:async messages=>{
      calls++;
      assert.match(messages[0].content,/不得增删/);
      return {content:JSON.stringify(await reply(JSON.parse(messages[1].content).text,calls))};
    },
  }:require(id+'.ts');
  mod._compile(ts.transpileModule(readFileSync(`${__dirname}/auto-run-subtitle-format.ts`,'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText,`${__dirname}/auto-run-subtitle-format.ts`);
  return {format:mod.exports.createAutoRunSubtitleFormatter(),calls:()=>calls};
}
test('punctuation split does not call the model',async()=>{
  const mock=formatter(()=>{throw Error('should not call');});
  assert.equal(await mock.format(fixtures[2].input),fixtures[2].expected);
  assert.equal(mock.calls(),0);
});
test('unpunctuated subtitle calls the model separately and caches the exact text inside a run',async()=>{
  const mock=formatter(()=>({lines:['我们现在必须赶在天黑之前','找到回去的路！']}));
  const source='我们现在必须赶在天黑之前找到回去的路！';
  const [a,b]=await Promise.all([mock.format(source),mock.format(source)]);
  assert.equal(a,'我们现在必须赶在天黑之前\n找到回去的路！');
  assert.equal(b,a); assert.equal(mock.calls(),1);
});
test('model cannot change words, punctuation, ordering, create empty lines or add a third line',()=>{
  const source='我们现在必须赶在天黑之前找到回去的路！';
  for(const lines of [
    ['我们现在必须赶在天黑之前','找到回去的路。'],
    ['我们必须赶在天黑之前','找到回去的路！'],
    ['找到回去的路！','我们现在必须赶在天黑之前'],
    ['我们现在必须赶在天黑之前找到回去的路！',''],
    ['我们现在','必须赶在天黑之前','找到回去的路！'],
    ['我们现在\n必须赶在天黑之前','找到回去的路！'],
  ]) assert.throws(()=>validateSubtitleLineBreak(source,lines));
});
test('a failed model response is not cached as a successful split',async()=>{
  const mock=formatter((_text,n)=>n===1?{lines:['改了文字','不可以']}:{lines:['我们现在必须赶在天黑之前','找到回去的路！']});
  const source='我们现在必须赶在天黑之前找到回去的路！';
  await assert.rejects(mock.format(source),/改动了原文/);
  assert.equal(await mock.format(source),'我们现在必须赶在天黑之前\n找到回去的路！');
  assert.equal(mock.calls(),2);
});
