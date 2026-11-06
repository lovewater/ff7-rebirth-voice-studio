/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
function fixture(){const fs=require('node:fs'),ts=require('typescript'),Module=require('node:module'),cache={};function load(name){if(cache[name])return cache[name].exports;const m=new Module(__filename);cache[name]=m;m.require=id=>id.startsWith('./')?load(id.slice(2)):require(id);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/'+name+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);return m.exports;}return {...load('auto-run-model-policy'),...load('llm-model-context'),...load('auto-run-stage-context')};}
const passed={status:'passed',error:null,selected:'22'},failed={status:'failed',error:'未过时长',selected:'11'};
async function run(f,extra={}){const seen=[],done=[],events=[];await f.runAutoRunModels({attempt:async()=>{seen.push({...f.currentAutoRunStage(),model:f.currentChatModel()});f.captureAutoRunOutcome(failed);},event:async(model,outcome,stage)=>events.push([stage.index,outcome?.status]),canFallback:async()=>true,canUseGapSplit:async()=>true,finish:async x=>done.push(x),...extra});return{seen,done,events};}
test('三轮均Grok，只有第三轮允许补切，每轮24；全失败仅最终落库',async()=>{const f=fixture(),r=await run(f);assert.deepEqual(r.seen.map(s=>[s.index,s.model,s.allowGapSplit,s.limit]),[[1,'grok',false,24],[2,'grok',false,24],[3,'grok',true,24]]);assert.deepEqual(r.done,[failed]);assert.equal(r.events.length,6);assert.equal(f.currentAutoRunStage(),undefined);});
test('前两轮正常重试可能成功，成功后不进入补切',async()=>{for(const successAt of [1,2]){const f=fixture();let count=0;const r=await run(f,{attempt:async()=>f.captureAutoRunOutcome(++count===successAt?passed:failed)});assert.equal(count,successAt);assert.deepEqual(r.done,[passed]);}});
test('第二轮没有最终分句证据，停在第二轮，不因泛化错误字符串启动切刀',async()=>{const f=fixture(),r=await run(f,{canUseGapSplit:async()=>false});assert.equal(r.seen.length,2);assert.deepEqual(r.done,[failed]);});
test('人工锁定停止后续；服务故障和明确禁重试不跨轮',async()=>{for(const stop of ['human','service','explicit']){const f=fixture();const r=await run(f,{canFallback:async()=>stop!=='human',attempt:async()=>{if(stop==='service')f.stopAutoRunRetries();f.captureAutoRunOutcome(stop==='explicit'?{...failed,options:{noModelRetry:true}}:failed);}});if(stop!=='human')assert.equal(r.done[0].options.noModelRetry,true);else assert.match(r.done[0].error,/人工锁定/);assert.equal(r.done.length,1);}});
test('并发运行阶段和模型隔离，缺最终结果不能伪装成功',async()=>{const f=fixture();await Promise.all([1,2].map(success=>{let n=0;return run(f,{attempt:async()=>{const stage=f.currentAutoRunStage();await new Promise(r=>setTimeout(r,success));assert.equal(f.currentAutoRunStage(),stage);f.captureAutoRunOutcome(++n===success?passed:failed);}})}));await assert.rejects(run(f,{attempt:async()=>{}}),/未返回最终结果/);assert.equal(f.captureAutoRunOutcome(failed),false);});
test('four Grok tasks isolate all nested awaits from a concurrent explicit historical-provider context',async()=>{
 const f=fixture();
 await f.withChatModel('primary',async()=>{
  await Promise.all(Array.from({length:4},(_,i)=>run(f,{attempt:async()=>{
   const current=f.currentAutoRunStage();assert.equal(f.currentChatModel(),'grok');
   await new Promise(resolve=>setTimeout(resolve,i+1));assert.equal(f.currentChatModel(),'grok');assert.equal(f.currentAutoRunStage(),current);f.captureAutoRunOutcome(passed);
  }})));
  assert.equal(f.currentChatModel(),'primary');assert.equal(f.currentAutoRunStage(),undefined);
 });
 assert.equal(f.currentChatModel(),undefined);
});

test('explicit GLM stays GLM through all three stages while concurrent defaults stay Grok',async()=>{
 const f=fixture();await Promise.all(['primary','grok'].map(model=>run(f,{model,attempt:async()=>{const stage=f.currentAutoRunStage();await new Promise(r=>setTimeout(r,2));assert.equal(f.currentChatModel(),model);assert.equal(stage.model,model);f.captureAutoRunOutcome(failed);}})));assert.equal(f.currentChatModel(),undefined);
 const result=await run(f,{model:'primary'});assert.deepEqual(result.seen.map(x=>x.model),['primary','primary','primary']);assert.equal(result.seen[2].allowGapSplit,true);assert.deepEqual(result.done,[failed]);
});
