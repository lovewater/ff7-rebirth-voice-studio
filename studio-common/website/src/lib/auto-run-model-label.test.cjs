/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),Module=require('node:module');
const m=new Module(__filename);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/auto-run-model-label.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,__filename);
const label=m.exports.autoRunStageLabel;
test('new Grok scene and field labels retain their different retry policies',()=>{
 assert.equal(label('performance',{model:'grok',stage:1,allowGapSplit:false}),'Grok 4.7 · 第1/3轮');
 assert.match(label('performance',{model:'grok',stage:3,allowGapSplit:true}),/第3\/3轮 · 允许补切/);
 assert.equal(label('casual',{model:'grok',stage:1}),'Grok 4.7 · 普通时长单轮');
});
test('persisted GLM and DeepSeek history keeps its actual provider and never becomes Grok',()=>{
 for(const model of ['primary','volcengine']){const text=label('performance',{model,stage:2});if(model==='volcengine')assert.match(text,/历史/);assert.doesNotMatch(text,/Grok|\/3轮/);}
 assert.match(label('performance',{model:'primary',stage:3,allowGapSplit:true}),/官方GLM 5.3/);
 for(const payload of [undefined,null,{}, {model:'unknown'}])assert.equal(label('performance',payload),'');
});
