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
function loadReflow() {
 const file=__dirname+'/subtitle-reflow.ts',m=new Module(file);
 m.require=id=>require(id+'.ts');
 m._compile(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
 return m.exports;
}
function formatter(reply,options={}) {
  let calls=0;
  const mod=new Module(__filename);
  mod.require=id=>id==='./auto-run-llm'?{
    parseJsonObject:JSON.parse,
    rewriteChat:async messages=>{
      calls++;
      assert.match(messages[0].content,/不得增删/);
      return {content:JSON.stringify(await reply(JSON.parse(messages[1].content).text,calls))};
    },
  }:id==='./subtitle-reflow'?loadReflow():require(id+'.ts');
  mod._compile(ts.transpileModule(readFileSync(`${__dirname}/auto-run-subtitle-format.ts`,'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText,`${__dirname}/auto-run-subtitle-format.ts`);
  return {format:mod.exports.createAutoRunSubtitleFormatter(options),calls:()=>calls};
}
test('punctuation split does not call the model',async()=>{
  const mock=formatter(()=>{throw Error('should not call');});
  assert.equal((await mock.format(fixtures[2].input)).replace(/\n/g,''),fixtures[2].input);
  assert.equal(mock.calls(),0);
});
test('unpunctuated subtitle uses local word boundaries with zero model calls',async()=>{
 const mock=formatter(()=>{throw Error('model must not be called');});
 const source='我们现在必须赶在天黑之前找到回去的路！';
 const a=await mock.format(source);
 assert.equal(a.replace(/\n/g,''),source);assert.equal(a.split('\n').length,2);assert.equal(mock.calls(),0);
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
test('reflow discards old breaks without inserting punctuation and uses no model',async()=>{
 const mock=formatter(()=>{throw Error('model must not be called');},{reflow:true});
 assert.equal(await mock.format('就算是伙伴\n我们塔克斯，有时也必须无情地舍弃'),'就算是伙伴我们塔克斯\n有时也必须无情地舍弃');
 assert.equal(await mock.format('好的\n知道了！'),'好的知道了！');
 assert.equal(await mock.format('就算是伙伴，我们塔克斯，有时也必须无情地舍弃'),'就算是伙伴，我们塔克斯\n有时也必须无情地舍弃');
 assert.equal(await mock.format('就算是伙伴，我们塔克斯\n有时也必须无情地舍弃'),'就算是伙伴，我们塔克斯\n有时也必须无情地舍弃');
 assert.equal(mock.calls(),0);
});
test('local layout preserves numbers, ellipses and all body characters',()=>{
 const {reflowSubtitleLocally:format}=loadReflow();
 for(const source of ['实际金额为12345678901234567890元，请不要搞错了！','你说什么？难道这件事情……真的完全无法挽回了吗？','我们现在必须赶在天黑之前找到回去的路！']){
  const result=format(source);assert.equal(result.replace(/[\s\p{P}\p{S}]/gu,''),source.replace(/[\s\p{P}\p{S}]/gu,''));
  assert.ok(result.split('\n').length<=2);assert.doesNotMatch(result,/…\n…|\d\n\d/);
 }
 const digits='123456789012345678901234567890';assert.equal(format(digits),digits);
});
test('reflow rejects rewritten wording or removed rhetorical punctuation',()=>{
 const {validateReflowSubtitleLines:validate,flattenSubtitleForReflow:flatten}=loadReflow();
 assert.equal(flatten('甲？\n乙……\n丙...\n丁！'),'甲？乙……丙...丁！');
 assert.throws(()=>validate('你真的认为这件事情……已经完全结束了吗？',['你真的认为这件事情','已经完全结束了吗？']),/改动/);
 assert.throws(()=>validate('我们塔克斯，有时必须无情地舍弃伙伴',['我们塔克斯','有时必须冷酷地舍弃伙伴']),/改动/);
 assert.throws(()=>validate('实际金额是12.50元然后离开',['实际金额是12','50元然后离开']),/数字/);
});

test('temporary line split keeps punctuation until final reflow; missing source punctuation is restored, not invented',async()=>{
 const source='虽然称不上是证据。但有几个理由足以让我们这么相信';
 const interim=formatter(()=>{throw Error('no model');});
 const draft=await interim.format(source);
 assert.equal(draft.replace(/\n/g,''),source);
 const final=formatter(()=>{throw Error('no model');},{reflow:true});
 const result=await final.format('虽然称不上是证据\n但有几个理由足以让我们这么相信',source);
 assert.match(result,/证据(?:，|\n)/);assert.doesNotMatch(result,/[，。]($|\n)/u);
 const moved=await final.format('这是事实但是我们已经有足够的证据相信这里的消息','这是事实。但是我们已经有足够的证据相信这里的消息');
 assert.match(moved,/事实，/);
 assert.equal(result.replace(/[\s\p{P}\p{S}]/gu,''),source.replace(/[\s\p{P}\p{S}]/gu,''));
 const {restoreSubtitleSourcePunctuation:restore}=loadReflow();
 assert.equal(restore('第一句\n第二句','第一句第二句'),'第一句\n第二句');
 assert.equal(restore('第一句\n第二句','别的句子。第二句'),'第一句\n第二句');
 assert.equal(restore('第一句？\n第二句','第一句。第二句'),'第一句？\n第二句');
 assert.equal(restore('第一句\n第二句','第一句。第二句'),'第一句。\n第二句');
});
