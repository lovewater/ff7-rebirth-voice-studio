const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const m=new Module(__filename);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/casual-duration-workflow.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
const {runCasualDurationWorkflow:run,casualDurationPass:pass}=m.exports;
const row=(script,duration,textPassed=true)=>({id:script,script,duration,textPassed,reason:''});
test('strict ceiling accepts equal or shorter, rejects missing and invalid measurements',()=>{
 for(const duration of [1,2])assert.equal(pass(row('全文',duration),2),true);
 for(const duration of [2.000001,0,NaN,Infinity])assert.equal(pass(row('全文',duration),2),false);
 assert.equal(pass(row('全文',1,false),2),false);
});
test('original verbatim pass never calls rewrite',async()=>{
 let calls=0;const original='原文，完整照读。';
 const result=await run({original,target:2,guard:async()=>{},attempt:async(s,n)=>{assert.equal(s,original);assert.equal(n,0);calls++;return row(s,2)},rewrite:async()=>assert.fail()});
 assert.equal(result.passed,true);assert.equal(calls,1);
});
test('three compression rounds use measured feedback then stop at four total syntheses',async()=>{
 const scripts=['原始中文一共有很多字','原始中文有很多字','中文有很多字','中文很多字'];let rewrites=0;
 const result=await run({original:scripts[0],target:1,guard:async()=>{},attempt:async(s,n)=>{assert.equal(s,scripts[n]);return row(s,4-n*.5)},rewrite:async(prev,budget,n)=>{assert.ok(budget<prev.script.length);rewrites++;return scripts[n]}});
 assert.equal(result.passed,false);assert.equal(rewrites,3);assert.equal(result.attempts.length,4);assert.equal(result.selected.script,scripts[3]);
});
test('a passing compressed result stops early',async()=>{
 const result=await run({original:'完整原始中文',target:2,guard:async()=>{},attempt:async(s,n)=>row(s,n===0?3:1.8),rewrite:async()=> '完整中文'});
 assert.equal(result.passed,true);assert.equal(result.attempts.length,2);
});
test('missing words retry same text and cannot be hidden by shortening',async()=>{
 const result=await run({original:'一句原文',target:2,guard:async()=>{},attempt:async(s)=>{assert.equal(s,'一句原文');return row(s,1,false)},rewrite:async()=>assert.fail()});
 assert.equal(result.passed,false);assert.equal(result.attempts.length,4);
});
test('manual state guard stops further generation; failed rewrite preserves recorded audio',async()=>{
 let n=0;await assert.rejects(run({original:'全文原稿',target:1,guard:async()=>{if(n++)throw Error('人工已选择')},attempt:async(s)=>row(s,2),rewrite:async()=>assert.fail()}),/人工已选择/);
 const result=await run({original:'全文原稿',target:1,guard:async()=>{},attempt:async(s)=>row(s,2),rewrite:async()=>{throw Error('API failure')}});
 assert.equal(result.passed,false);assert.equal(result.selected.id,'全文原稿');assert.equal(result.rewriteError,'API failure');
});
