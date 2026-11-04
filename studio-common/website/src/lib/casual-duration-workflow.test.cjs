/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const m=new Module(__filename);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/casual-duration-workflow.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
const {runCasualDurationWorkflow:run,casualDurationPass:pass,casualCompressionPlan:plan,chooseCasualPassing:pick}=m.exports;
const row=(script,duration,textPassed=true,id=script)=>({id,script,duration,textPassed,reason:''});
const base={original:'完整原始中文台词',target:1,guard:async()=>{},rewrite:async()=>assert.fail('must not rewrite')};
test('ceiling accepts at most 1ms rounding and rejects invalid measurements',()=>{
 for(const d of [.1,1,1.001])assert.equal(pass(row('全文',d),1),true);
 for(const d of [1.001001,0,-1,NaN,Infinity])assert.equal(pass(row('全文',d),1),false);
 assert.equal(pass(row('全文',.5,false),1),false);assert.equal(pass({...row('全文',.5),processingFailed:true},1),false);
});
for(const successAt of [1,2,3])test(`original success at attempt ${successAt} stops before any rewrite`,async()=>{
 let calls=0;const r=await run({...base,attempt:async(s,round,count,n)=>{calls++;assert.equal(round,0);assert.equal(count,1);assert.equal(n,calls);assert.equal(s,base.original);return row(s,calls===successAt?.9:2,true,'id'+calls);}});
 assert.equal(r.passed,true);assert.equal(calls,successAt);assert.equal(r.selected.id,'id'+successAt);
});
test('three original singles precede three rewrite batches: native maximum 3+3x3=12',async()=>{
 const scripts=[base.original,'完整中文台词','完整中文','中文'],requests=[];let native=0,rewrites=0;
 const r=await run({...base,attempt:async(s,round,count)=>{requests.push([s,round,count]);return Array.from({length:count},()=>row(s,4-round*.3,true,String(++native)));},rewrite:async(previous,budget,round)=>{assert.equal(requests.length,round+2);assert.ok(budget<previous.script.length);rewrites++;return scripts[round];}});
 assert.equal(r.passed,false);assert.equal(native,12);assert.equal(rewrites,3);assert.equal(requests.length,6);
 assert.deepEqual(requests.map(r=>r[2]),[1,1,1,3,3,3]);assert.deepEqual(requests.slice(0,3).map(r=>r[0]),[base.original,base.original,base.original]);
});
test('after three original nuclear failures, text is never shortened to hide missing words',async()=>{
 let calls=0;const r=await run({...base,attempt:async(s,round,count)=>{calls++;assert.equal(s,base.original);assert.equal(round,0);assert.equal(count,1);return row(s,.5,false,String(calls));}});
 assert.equal(r.passed,false);assert.equal(calls,3);
});
test('all post-rewrite candidates are checked, hard failures excluded, fewer notes and less processing win',async()=>{
 let calls=0,rewrites=0;
 const r=await run({...base,attempt:async(s,round,count)=>{calls++;if(!round)return row(s,2,true,'raw'+calls);assert.equal(count,3);return [
  {...row(s,.2,true,'doubt'),pronunciationNotes:['读音疑点']},
  {...row(s,.9,true,'edited'),processingSteps:2},
  {...row(s,.8,true,'natural'),processingSteps:0}];},rewrite:async()=>{rewrites++;return '完整中文';}});
 assert.equal(calls,4);assert.equal(rewrites,1);assert.equal(r.passed,true);assert.equal(r.selected.id,'natural');
});
test('same-quality valid candidates use generation order, never shortest or closest-to-JP as ranking target',()=>{
 for(const durations of [[.9,.2],[.2,.9]])assert.equal(pick([row('全文',durations[0],true,'first'),row('全文',durations[1],true,'second')],1).id,'first');
 assert.equal(pick([{...row('全文',.1,true,'bad'),processingFailed:true},row('全文',.9,false,'missing'),row('全文',.8,true,'ok')],1).id,'ok');
});
for(const count of [1,2])test(`partial rewrite batch with ${count} native outputs can select a verified survivor`,async()=>{
 let n=0;const r=await run({...base,attempt:async(s,round,requested)=>!round?row(s,2,true,'raw'+(++n)):Array.from({length:count},(_,i)=>{assert.equal(requested,3);return row(s,.8,true,'valid'+i)}),rewrite:async()=> '完整中文'});
 assert.equal(r.passed,true);assert.equal(r.selected.id,'valid0');
});
test('after rewrite, all missing-word batches retry the same script and cannot revive a hard failure',async()=>{
 let native=0,rewrites=0;const scripts=[];
 const r=await run({...base,attempt:async(s,round,count)=>{scripts.push(s);return Array.from({length:count},()=>row(s,round?.4:2,!round,String(++native)));},rewrite:async()=>{rewrites++;return '完整中文';}});
 assert.equal(r.passed,false);assert.equal(native,12);assert.equal(rewrites,1);assert.deepEqual(scripts.slice(3),['完整中文','完整中文','完整中文']);
});
test('each post-rewrite overlong candidate gets its own edit/check; failed edit nuclear result stays rejected',async()=>{
 let n=0,edits=0;const r=await run({...base,attempt:async(s,round,count)=>Array.from({length:count},()=>row(s,round?1.1:2,true,String(++n))),rewrite:async()=> '完整中文',compress:async previous=>{
  edits++;return {...row(previous.script,.99,edits!==1,'edit'+previous.id),processingSteps:1,pronunciationNotes:edits===3?['疑点']:[]};
 }});
 assert.equal(n,6);assert.equal(edits,3);assert.equal(r.passed,true);assert.equal(r.selected.id,'edit5');
});
test('one ordinary DSP error does not discard a sibling candidate; explicit intervention stops everything',async()=>{
 let n=0;const r=await run({...base,attempt:async(s,round,count)=>Array.from({length:count},()=>row(s,round?1.1:2,true,String(++n))),rewrite:async()=> '完整中文',compress:async p=>{if(p.id==='4')throw Error('DSP failure');return row(p.script,.99,true,'edit'+p.id);}});
 assert.equal(r.passed,true);assert.equal(r.selected.id,'edit5');
 await assert.rejects(run({...base,attempt:async s=>row(s,1.1),compress:async()=>{const e=Error('manual changed source');e.name='CasualInterventionError';throw e;}}),/manual/);
});
test('empty native responses exhaust three original tries without fabricated selection or rewrite',async()=>{
 let calls=0;const r=await run({...base,attempt:async()=>{calls++;return [];}});assert.equal(calls,3);assert.equal(r.passed,false);assert.equal(r.selected,undefined);
});
test('manual guard after an attempt or an edit prevents selection and further requests',async()=>{
 for(const stop of ['attempt','edit']) {let marked=false;
  await assert.rejects(run({...base,guard:async()=>{if(marked)throw Error('manual wins')},attempt:async s=>{marked=stop==='attempt';return row(s,1.1);},compress:async p=>{marked=true;return row(p.script,1);}}),/manual wins/);
 }
});
test('duplicate IDs inside one batch cannot reuse verification; invalid targets never generate',async()=>{
 let n=0;await assert.rejects(run({...base,attempt:async(s,round)=>!round?row(s,2,true,String(++n)):[row(s,.5,true,'same'),row(s,.6,true,'same')],rewrite:async()=> '完整中文'}),/ID重复/);
 for(const target of [0,-1,NaN,Infinity])await assert.rejects(run({...base,target,attempt:async()=>assert.fail()}),/无效/);
});
test('failed rewrite preserves audio; original compression costs no new native candidate or rewrite',async()=>{
 let calls=0;const ok=await run({...base,target:.9,attempt:async s=>{calls++;return row(s,1);},compress:async p=>row(p.script,.9,true,'edited')});
 assert.equal(ok.passed,true);assert.equal(ok.selected.id,'edited');assert.equal(calls,1);
 const failed=await run({...base,attempt:async s=>row(s,2),rewrite:async()=>{throw Error('API failure')}});assert.equal(failed.passed,false);assert.equal(failed.rewriteError,'API failure');
});
test('nonperformance exact .85 compression boundary and unchanged1ms timing tolerance',async()=>{
 assert.equal(plan(10000,1000,8.5).ratio,.85);assert.equal(plan(10000,1000,8.499999),null);assert.equal(plan(10000,1000,8.5009).targetFrames,8500);
 for(const args of [[0,1000,9],[10000,0,9],[NaN,1000,9],[10000,Infinity,9],[10000,1000,NaN]])assert.equal(plan(...args),null);
 const r=await run({...base,target:3.3,attempt:async s=>row(s,3.301),compress:async()=>assert.fail()});assert.equal(r.passed,true);
});

test('failed compression verification never becomes rewrite evidence; complete raw reading remains valid evidence after three tries',async()=>{
 let n=0,rewrites=0;
 const r=await run({...base,target:9,attempt:async(s,round,count)=>Array.from({length:count},()=>row(s,round?8.5:10,true,'raw'+(++n))),compress:async previous=>row(previous.script,9,false,'failed-edit-'+previous.id),rewrite:async previous=>{rewrites++;assert.match(previous.id,/^raw/);assert.equal(previous.duration,10);assert.equal(n,3);return '完整中文';}});
 assert.equal(r.passed,true);assert.equal(n,6);assert.equal(rewrites,1);assert.equal(r.selected.id,'raw4');
});
test('reused original is assessed before native generation and a passing edit consumes no TTS',async()=>{
 let native=0,reused=0;
 const r=await run({...base,target:9,reuseAttempt:async index=>{reused++;return index===0?[row(base.original,10,true,'old-copy')]:null;},attempt:async()=>{native++;throw Error('must not synthesize')},compress:async p=>row(p.script,9,true,'fresh-edited-copy'),review:async p=>{p.semanticPassed=true;}});
 assert.equal(r.passed,true);assert.equal(r.selected.id,'fresh-edited-copy');assert.equal(reused,1);assert.equal(native,0);
});
test('meaning rejection is fed back within three rounds and may restore longer text instead of monotonic deletion',async()=>{
 const original='用这招解决你',seen=[];let n=0,repairs=0;
 const r=await run({...base,original,attempt:async(s,round,count)=>Array.from({length:count},()=>row(s,!round?2:.8,true,String(++n))),review:async p=>{p.semanticPassed=p.script!=='够';p.semanticFailureKind=p.semanticPassed?undefined:'meaning';p.semanticFeedback=p.semanticPassed?'':'丢失动作与对象';},rewrite:async(p,budget)=>{seen.push({script:p.script,budget,feedback:p.semanticFeedback});return ++repairs===1?'够':'用这招打倒你';}});
 assert.equal(r.passed,true);assert.equal(r.selected.script,'用这招打倒你');assert.equal(repairs,2);assert.equal(seen[1].script,'够');assert.ok(seen[1].budget>=original.length);assert.match(seen[1].feedback,/动作/);
});
test('original pronunciation uncertainty only retries original and cannot enter rewrite or lock',async()=>{
 let n=0;const r=await run({...base,attempt:async s=>row(s,.8,true,String(++n)),review:async p=>{p.semanticPassed=false;p.semanticFailureKind='reading';p.semanticFeedback='是能/只能不确定';}});
 assert.equal(n,3);assert.equal(r.passed,false);assert.equal(r.selected,undefined);
});
test('fallback prefers faithful long original over shorter semantic-rejected 够',async()=>{
 let n=0;const r=await run({...base,attempt:async(s,round,count)=>Array.from({length:count},()=>row(s,round?.3:2,true,String(++n))),review:async p=>{p.semanticPassed=p.script!== '够';p.semanticFailureKind=p.semanticPassed?undefined:'meaning';},rewrite:async()=> '够'});
 assert.equal(r.passed,false);assert.equal(r.selected.script,base.original);assert.equal(r.selected.semanticPassed,true);
});
