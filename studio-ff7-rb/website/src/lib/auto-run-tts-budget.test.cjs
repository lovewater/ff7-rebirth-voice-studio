/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
function fixture(initial=0){
 const usage=new Map([['run',initial]]),events=[],outcomes=[],cache=new Map();let tail=Promise.resolve();
 const sql=async(strings,...values)=>{const q=strings.join('?');
  if(q.includes('FOR UPDATE'))return values[0]==='ended'?[]:[{id:values[0]}];
  if(q.includes('SELECT GREATEST'))return[{used:usage.get(values[0])??0}];
  if(q.includes('INSERT INTO line_auto_run_events')){const payload=values.at(-1);events.push({q,values});if(q.includes('tts-budget-reserve'))usage.set(values[0],payload.used);}
  if(q.includes('FROM line_tts_versions v LEFT JOIN line_meta'))return[
   {id:'earlier',dur_s:2,target:2,conversion_meta:{attempt_feedback:{status:'accepted',issues:[]}}},
   {id:'last',dur_s:1,target:2,conversion_meta:{attempt_feedback:{status:'rejected',issues:[{code:'text-missing',severity:'error'}]}}}];
  return[];
 };sql.json=x=>x;sql.begin=async fn=>{const previous=tail;let release;tail=new Promise(r=>release=r);await previous;try{return await fn(sql);}finally{release();}};
 function load(file){if(cache.has(file))return cache.get(file).exports;const m=new Module(file);cache.set(file,m);m.require=id=>{
  if(id==='./db')return{sql};
  if(id==='./auto-run-model-policy')return{captureAutoRunOutcome:outcome=>{outcomes.push(outcome);return true;}};
  if(id==='./llm-model-context')return{currentChatModel:()=>undefined};
  if(id==='./auto-run-rules')return{isPerformanceMode:()=>true};
  if(id==='./singing-original')return{isSingingLine:()=>false};
  if(id==='./pure-interjection')return{pureInterjectionOriginal:()=>false};
  if(id==='./shushu-emotion')return{pureShushuOriginal:()=>false};
  if(id==='./auto-run-tts-budget'||id==='./auto-run-fallback')return load(path.resolve(path.dirname(file),id+'.ts'));
  return{};
 };m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText+(file.endsWith('/auto-run.ts')?'\nexports.testGenerate=generateClone;exports.testFinishBudget=finishAtTtsBudget;exports.testMeasured=()=>{loadLine=async()=>({stem:"stem",text_zh:"台词",text_jp:"台詞",dialogue_mode:"scene"});runPerformance=async()=>{throw new auto_run_tts_budget_1.AutoTtsBudgetError();};return executeAutoRunMeasured("run","stem",{});};':''),file);return m.exports;}
 return{...load(__dirname+'/auto-run-tts-budget.ts'),usage,events,outcomes,workflow:()=>load(__dirname+'/auto-run.ts')};
}
test('29条时三候选请求只能再生成1条，30条后拒绝任何新请求',async()=>{
 const f=fixture(29),b=await f.reserveAutoTtsSlots('run','stem',3);assert.equal(b.count,1);assert.equal(b.used,30);assert.equal(b.exhausted,true);
 await assert.rejects(f.reserveAutoTtsSlots('run','stem',3),f.AutoTtsBudgetError);assert.equal(f.events.length,1);
});
test('多个并发申请共享持久总额；模型切换不重置，同任务失败合成仍计数',async()=>{
 const f=fixture();const results=await Promise.allSettled(Array.from({length:12},()=>f.reserveAutoTtsSlots('run','stem',3)));
 assert.equal(results.filter(r=>r.status==='fulfilled').reduce((n,r)=>n+r.value.count,0),30);assert.equal(f.usage.get('run'),30);
 await assert.rejects(f.reserveAutoTtsSlots('run','stem',1),f.AutoTtsBudgetError);
 assert.equal((await f.reserveAutoTtsSlots('other-run','stem2',1)).used,1);
 await assert.rejects(f.reserveAutoTtsSlots('ended','stem',3),/已结束/);
});
test('预算兜底跨模型保留核字较好的早期候选，而非最后一条或纯时长最短的',()=>{
 const f=fixture(),known={status:'accepted',issues:[]};
 const chosen=f.chooseBudgetFallback([{id:'missing',dur_s:2,target:2,conversion_meta:{attempt_feedback:{status:'rejected',issues:[{code:'text-missing'}]}}},{id:'good',dur_s:2.2,target:2,conversion_meta:{attempt_feedback:known}},{id:'unreviewed',dur_s:2,target:2,conversion_meta:null}]);assert.equal(chosen.id,'good');
 assert.equal(f.chooseBudgetFallback([]),null);
});
test('第30条保存后立即退出，不继续核字或生成；最终强选答案、失败并禁止第二模型',async()=>{
 const f=fixture(),w=f.workflow(),oldFetch=global.fetch;let requests=0;
 global.fetch=async()=>{requests++;return{ok:true,json:async()=>({ids:['new30'],ttsBudget:{exhausted:true}})};};
 try{await assert.rejects(w.testGenerate('run','stem','原稿'),f.AutoTtsBudgetError);}finally{global.fetch=oldFetch;}
 assert.equal(requests,1);await w.testFinishBudget('run');
 assert.deepEqual(f.outcomes,[{status:'failed',error:f.AUTO_TTS_LIMIT_MESSAGE,selected:'earlier',options:{noModelRetry:true,preserveSubtitle:true}}]);
 assert.ok(f.events.some(e=>e.values.includes('tts-limit')));
});
test('GPU全失败但已耗尽预算的HTTP错误也能触发停止',async()=>{
 const f=fixture(),w=f.workflow(),oldFetch=global.fetch;
 global.fetch=async()=>({ok:false,status:409,json:async()=>({error:'GPU unavailable',code:'AUTO_TTS_LIMIT'})});
 try{await assert.rejects(w.testGenerate('run','stem','原稿'),f.AutoTtsBudgetError);}finally{global.fetch=oldFetch;}
});
test('真实自动执行入口捕获上限错误，提交失败和候选且禁止模型重跑',async()=>{
 const f=fixture();await f.workflow().testMeasured();assert.equal(f.outcomes.length,1);
 assert.equal(f.outcomes[0].status,'failed');assert.equal(f.outcomes[0].selected,'earlier');assert.equal(f.outcomes[0].options.noModelRetry,true);
});
