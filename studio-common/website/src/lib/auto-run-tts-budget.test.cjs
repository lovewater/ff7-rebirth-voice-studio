/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const policyModule=new Module(__filename);
policyModule.require=id=>id==='./auto-run-rules'?require('./auto-run-rules.ts'):require(id);
policyModule._compile(ts.transpileModule(fs.readFileSync(__dirname+'/auto-run-gap-policy.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,__filename);
const clonePolicy=policyModule.exports;
function fixture(initial=0){
 const usage=new Map([['run:1',initial]]),events=[],outcomes=[],cache=new Map(),active=new Map();let tail=Promise.resolve();
 const sql=async(strings,...values)=>{const q=strings.join('?');
  if(q.includes('FOR UPDATE'))return values[0]==='ended'?[]:[{id:values[0]}];
  if(q.includes('SELECT step FROM line_auto_run_events')){const e=[...events].reverse().find(e=>e.values[0]===values[0]&&e.values.at(-1)?.stage===2&&e.values.at(-1)?.model===values[1]&&['stage-tts-batch','stage-split-failure'].includes(e.values[1]));return e?[{step:e.values[1]}]:[];}
  if(q.includes('SELECT payload'))return active.has(values[0])?[{payload:{stage:active.get(values[0])}}]:[];
  if(q.includes('SELECT GREATEST'))return[{used:usage.get(values[0]+':'+values[1])??0}];
  if(q.includes('INSERT INTO line_auto_run_events')){const payload=values.at(-1);events.push({q,values});if(q.includes('tts-budget-reserve'))usage.set(values[0]+':'+payload.stage,payload.used);}
  if(q.includes('FROM line_tts_versions v LEFT JOIN line_meta'))return[
   {id:'earlier',dur_s:2,target:2,conversion_meta:{attempt_feedback:{status:'accepted',issues:[]}}},
   {id:'last',dur_s:1,target:2,conversion_meta:{attempt_feedback:{status:'rejected',issues:[{code:'text-missing',severity:'error'}]}}}];
  return[];
 };sql.json=x=>x;sql.begin=async fn=>{const previous=tail;let release;tail=new Promise(r=>release=r);await previous;try{return await fn(sql);}finally{release();}};
 function load(file){if(cache.has(file))return cache.get(file).exports;const m=new Module(file);cache.set(file,m);m.require=id=>{
  if(id==='./db')return{sql};
  if(id.startsWith('node:'))return require(id);
  if(id==='./auto-run-model-policy')return{captureAutoRunOutcome:outcome=>{outcomes.push(outcome);return true;}};
  if(id==='./llm-model-context')return{currentChatModel:()=>undefined,withChatModel:(model,fn)=>fn()};
  if(id==='./llm-metrics')return{withLlmMetrics:(run,stem,fn)=>fn()};
  if(id==='./auto-run-two-parts')return{withTwoPartContext:fn=>fn()};
  if(id==='./auto-run-rules')return require('./auto-run-rules.ts');
  if(id==='./singing-original')return{isSingingLine:()=>false};
  if(id==='./pure-interjection')return{pureInterjectionOriginal:()=>false};
  if(id==='./shushu-emotion')return{pureShushuOriginal:()=>false};
  if(id==='./auto-run-stage-context'||id==='./auto-run-tts-budget'||id==='./auto-run-fallback')return load(path.resolve(path.dirname(file),id+'.ts'));
  return{};
 };m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText+(file.endsWith('/auto-run.ts')?'\nexports.testSplitEvidence=finalSplitFailureEvidence;exports.testExplicit=async()=>{loadLine=async()=>({dialogue_mode:"field"});runCasualDuration=async()=>generateClone("run","stem","原稿");return executeCasualDurationReview("run","stem");};exports.testField=async()=>{loadLine=async()=>({dialogue_mode:"field"});executeAutoRunMeasured=async()=>generateClone("run","stem","原稿");return executeAutoRun("run","stem");};exports.testGenerate=generateClone;exports.testFinishBudget=finishAtTtsBudget;exports.testMeasured=()=>{loadLine=async()=>({stem:"stem",text_zh:"台词",text_jp:"台詞",dialogue_mode:"scene"});runPerformance=async()=>{throw new auto_run_tts_budget_1.AutoTtsBudgetError();};return executeAutoRunMeasured("run","stem",{});};':''),file);return m.exports;}
 return{...load(__dirname+'/auto-run-tts-budget.ts'),usage,events,outcomes,active,workflow:()=>load(__dirname+'/auto-run.ts')};
}
test('23条时三候选请求只能再生成1条，24条后拒绝任何新请求',async()=>{
 const f=fixture(23),b=await f.reserveAutoTtsSlots('run','stem',3);assert.equal(b.count,1);assert.equal(b.used,24);assert.equal(b.exhausted,true);
 await assert.rejects(f.reserveAutoTtsSlots('run','stem',3),f.AutoTtsBudgetError);assert.equal(f.events.length,1);
});
test('多个并发申请共享本轮持久额度，失败合成仍计数',async()=>{
 const f=fixture();const results=await Promise.allSettled(Array.from({length:12},()=>f.reserveAutoTtsSlots('run','stem',3)));
 assert.equal(results.filter(r=>r.status==='fulfilled').reduce((n,r)=>n+r.value.count,0),24);assert.equal(f.usage.get('run:1'),24);
 await assert.rejects(f.reserveAutoTtsSlots('run','stem',1),f.AutoTtsBudgetError);
 assert.equal((await f.reserveAutoTtsSlots('other-run','stem2',1)).used,1);
 await assert.rejects(f.reserveAutoTtsSlots('ended','stem',3),/已结束/);
});
test('预算兜底跨模型保留核字较好的早期候选，而非最后一条或纯时长最短的',()=>{
 const f=fixture(),known={status:'accepted',issues:[]};
 const chosen=f.chooseBudgetFallback([{id:'missing',dur_s:2,target:2,conversion_meta:{attempt_feedback:{status:'rejected',issues:[{code:'text-missing'}]}}},{id:'good',dur_s:2.2,target:2,conversion_meta:{attempt_feedback:known}},{id:'unreviewed',dur_s:2,target:2,conversion_meta:null}]);assert.equal(chosen.id,'good');
 assert.equal(f.chooseBudgetFallback([]),null);
});
test('第24条保存后继续返回音频接受验收；本轮预算停止不禁止后续轮次',async()=>{
 const f=fixture(),w=f.workflow(),oldFetch=global.fetch;let requests=0,body;
 global.fetch=async(url,options)=>{requests++;body=JSON.parse(options.body);return{ok:true,json:async()=>({ids:['new24'],ttsBudget:{exhausted:true}})};};
 try{await w.testGenerate('run','stem','原稿');}finally{global.fetch=oldFetch;}
 assert.equal(requests,1);assert.equal(body.autoRunStage,1);await w.testFinishBudget('run');
 assert.deepEqual(f.outcomes,[{status:'failed',error:f.AUTO_TTS_LIMIT_MESSAGE,selected:'earlier',options:{preserveSubtitle:true}}]);
 assert.ok(f.events.some(e=>e.values.includes('tts-limit')));
});
test('GPU全失败但已耗尽预算的HTTP错误也能触发停止',async()=>{
 const f=fixture(),w=f.workflow(),oldFetch=global.fetch;
 global.fetch=async()=>({ok:false,status:409,json:async()=>({error:'GPU unavailable',code:'AUTO_TTS_LIMIT'})});
 try{await assert.rejects(w.testGenerate('run','stem','原稿'),f.AutoTtsBudgetError);}finally{global.fetch=oldFetch;}
});
test('真实自动执行入口捕获本轮上限，保留本轮候选允许后续轮重跑',async()=>{
 const f=fixture();await f.workflow().testMeasured();assert.equal(f.outcomes.length,1);
 assert.equal(f.outcomes[0].status,'failed');assert.equal(f.outcomes[0].selected,'earlier');assert.equal(f.outcomes[0].options.noModelRetry,undefined);
});

test('三轮分别24共72且旧事件仅计入第一轮，陈旧并发请求不能回到旧轮',async()=>{
 const f=fixture(24);
 await assert.rejects(f.reserveAutoTtsSlots('run','stem',1,1),f.AutoTtsBudgetError);
 for(const stage of [2,3]){f.active.set('run',stage);const results=await Promise.allSettled(Array.from({length:12},()=>f.reserveAutoTtsSlots('run','stem',3,stage)));assert.equal(results.filter(x=>x.status==='fulfilled').reduce((n,x)=>n+x.value.count,0),24);assert.equal(f.usage.get('run:'+stage),24);}
 await assert.rejects(f.reserveAutoTtsSlots('run','stem',1,2),/阶段已变化/);
 assert.equal([...f.usage.values()].reduce((a,b)=>a+b,0),72);
});

test('field保持单轮且先持久登记正常stage1，随后HTTP声明可被服务器核验',async()=>{
 const f=fixture(),w=f.workflow(),oldFetch=global.fetch;let body;
 global.fetch=async(url,options)=>{body=JSON.parse(options.body);const start=f.events.find(e=>e.values.includes('model-stage-start'));assert.ok(start);const payload=start.values.at(-1);assert.equal(payload.stage,1);assert.equal(payload.allowGapSplit,false);assert.equal(clonePolicy.validatedCloneStage(body.autoRunStage,payload,body.autoRunModel),1);return{ok:true,json:async()=>({ids:['field1']})};};
 try{await w.testField();}finally{global.fetch=oldFetch;}
 assert.equal(body.autoRunStage,1);assert.equal(f.events.filter(e=>e.values.includes('model-stage-start')).length,1);
});

test('补切资格只认第二轮最后一批，后续非结构候选清掉旧证据，结尾通用fail不伪造原因',async()=>{
 const f=fixture(),w=f.workflow();const event=(step,stage=2,model='grok')=>f.events.push({values:['run',step,'result','',{stage,model}]});
 assert.equal(await w.testSplitEvidence('run'),null);
 event('stage-split-failure',1);assert.equal(await w.testSplitEvidence('run'),null);
 event('stage-split-failure',2,'primary');assert.equal(await w.testSplitEvidence('run'),null);
 event('stage-tts-batch');event('stage-split-failure');event('fail');assert.equal(await w.testSplitEvidence('run'),'stage-split-failure');
 event('stage-tts-batch');assert.equal(await w.testSplitEvidence('run'),'stage-tts-batch');
});

test('显式普通时长入口也先持久登记stage1，实际clone gate接受且禁止切刀',async()=>{
 const f=fixture(),w=f.workflow(),oldFetch=global.fetch;const policy=clonePolicy;let requests=0;
 global.fetch=async(url,options)=>{requests++;const body=JSON.parse(options.body),start=f.events.find(e=>e.values.includes('model-stage-start'));const stage=policy.validatedCloneStage(body.autoRunStage,start?.values.at(-1),body.autoRunModel);assert.equal(stage,1);assert.equal(policy.allowCloneGapSplit(stage,'field',true),false);return{ok:true,json:async()=>({ids:['field1']})};};
 try{await w.testExplicit();}finally{global.fetch=oldFetch;}
 assert.equal(requests,1);
});
