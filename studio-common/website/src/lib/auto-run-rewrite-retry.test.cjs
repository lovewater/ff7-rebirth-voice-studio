/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function fixture(options={}) {
 const cache=new Map(),waits=[],timeline=[];
 const mocks={
  './db':{sql:async()=>[]},
  './llm-metrics':{currentLlmStem:()=>undefined,beginLlmCall:async()=> 'test-log',recordLlmCall:async()=>{}},
  './auto-run-two-parts':{performanceRewriteMessages:messages=>messages},
  './rewrite-translation-reference':{withTranslationReferences:async messages=>messages},
  './rewrite-number-hint':{withRewriteNumberHint:messages=>messages},
  './prompt-store':{resolvePromptMessages:async messages=>messages},
  './beats':{NORMAL_JP_CN_RATIO:1.33},
  './tts-gpu':{normalizeScript:text=>({ttsText:text})},
  './auto-run-script-policy':{performanceSegmentationHint:()=>''},
  './rewrite-prompt':{REWRITE_COUNT:5,rewritePace:()=> '正常',rewriteMessages:x=>[{role:'user',content:JSON.stringify({draft:x.attempt,previous:x.previous.length})}],parseRewrite:raw=>{const p=JSON.parse(raw);if(!p.text)throw Error('empty text');return{...p,raw};}},
  'node:timers/promises':{setTimeout:async(ms,_value,{signal}={})=>{waits.push(ms);timeline.push('wait:'+ms);await options.onDelay?.(ms,signal);signal?.throwIfAborted();}},
 };
 function load(name){
  if(cache.has(name))return cache.get(name).exports;
  const m=new Module(__filename);cache.set(name,m);
  m.require=id=>Object.hasOwn(mocks,id)?mocks[id]:id.startsWith('./')?load(id.slice(2)):require(id);
  m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/'+name+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,__filename);
  return m.exports;
 }
 return {...load('auto-run-rewrite-retry'),...load('llm-grok'),load,waits,timeline};
}
test('a failed draft recovers on the third retry and preserves legacy immediate format retries',async()=>{
 const f=fixture();let calls=0;const events=[];const result=await f.retryRewriteDraft(4,async()=>{if(++calls<4)throw Error('no text');return '可用稿';},async e=>events.push(e));
 assert.equal(result,'可用稿');assert.equal(calls,4);assert.deepEqual(events.map(e=>e.nextAttempt),[2,3,4]);assert.ok(events.every(e=>e.draftNumber===4));assert.deepEqual(f.waits,[]);
});
test('four consecutive content failures stop with a typed error and no paid fifth request',async()=>{
 const f=fixture();let calls=0;await assert.rejects(f.retryRewriteDraft(2,async()=>{calls++;throw Error('invalid JSON');}),e=>e instanceof f.RewriteDraftUnavailableError&&e.draftNumber===2&&e.attempts===4&&/invalid JSON/.test(e.message));assert.equal(calls,4);
});
test('valid first response consumes no retry',async()=>{const f=fixture();let calls=0;assert.equal(await f.retryRewriteDraft(1,async()=>++calls),1);assert.equal(calls,1);});

function input(extra={}) {return {speaker:'',show:null,textJp:'',textEn:'',original:'原文',current:'当前稿',beats:{jp:{units:10}},before:[],after:[],jpAsr:{raw:{}},failNotes:[],measure:async()=>({jp:{units:10},cn:{units:10},normalizedRatio:1}),...extra};}
function content(draft){return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({text:'稿'+draft})}}]}));}
async function withHttp(f,reply,operation,model='grok'){
 const previousFetch=global.fetch,keys=['GROK_LLM_URL','GROK_LLM_KEY','GROK_LLM_MODEL','REWRITE_LLM_URL','REWRITE_LLM_KEY','REWRITE_LLM_MODEL'];
 const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 Object.assign(process.env,{GROK_LLM_URL:'https://example.invalid/v1',GROK_LLM_KEY:'grok-test-key',GROK_LLM_MODEL:'grok-4.7',REWRITE_LLM_URL:'https://example.invalid/v1',REWRITE_LLM_KEY:'glm-test-key',REWRITE_LLM_MODEL:'glm-5.3'});
 global.fetch=async(_url,init)=>{f.timeline.push('http');const body=JSON.parse(init.body);if(model==='grok'){assert.equal(body.model,'grok-4.7');assert.equal(body.reasoning_effort,'low');}return reply(JSON.parse(body.messages[0].content),init);};
 try{return await f.load('llm-model-context').withChatModel(model,operation);}
 finally{global.fetch=previousFetch;for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}}
}
test('actual five-draft loop keeps old-provider retry behavior without HTTP nesting or repeating successful drafts',async()=>{
 const f=fixture(),requests=[],failures=[];let secondFailures=0,measurements=0;
 await withHttp(f,async data=>{requests.push(data);return data.draft===1&&secondFailures++<3?new Response('{}',{status:500}):content(data.draft);},()=>f.load('auto-run-llm').rewriteFive(input({measure:async()=>{measurements++;return{jp:{units:10},cn:{units:10},normalizedRatio:1};},onRetry:async e=>failures.push(e)})),'primary');
 assert.equal(requests.length,8);assert.deepEqual(requests.map(r=>r.draft),[0,1,1,1,1,2,3,4]);assert.ok(requests.filter(r=>r.draft===1).every(r=>r.previous===1));assert.equal(measurements,10);assert.equal(failures.length,3);assert.deepEqual(f.waits,[]);
});
test('Grok four actual HTTP attempts cool down 15/30/60s; httpTries=1 prevents 3x4 amplification',async()=>{
 const f=fixture(),events=[];let calls=0;
 await withHttp(f,async()=>{calls++;return new Response('{}',{status:503});},async()=>{
  await assert.rejects(f.load('auto-run-llm').rewriteFive(input({attemptHistoryMode:true,onRetry:async e=>events.push(e)})),e=>e instanceof f.RewriteDraftUnavailableError&&e.attempts===4);
 });
 assert.equal(calls,4);assert.deepEqual(f.waits,[15000,30000,60000]);assert.deepEqual(events.map(e=>e.retryDelayMs),f.waits);assert.deepEqual(f.timeline,['http','wait:15000','http','wait:30000','http','wait:60000','http']);
});
test('Grok successful recovery respects bounded Retry-After without consuming other drafts',async()=>{
 const f=fixture();let calls=0;
 await withHttp(f,async data=>++calls===1?new Response('{}',{status:503,headers:{'retry-after':'999'}}):content(data.draft),()=>f.load('auto-run-llm').rewriteFive(input({attemptHistoryMode:true})));
 assert.equal(calls,2);assert.deepEqual(f.waits,[60000]);
});
test('Grok authentication and other nonretryable HTTP errors escape immediately',async()=>{
 for(const status of [400,401,403,404]){
  const f=fixture();let calls=0;
  await withHttp(f,async()=>{calls++;return new Response('{}',{status});},async()=>assert.rejects(f.load('auto-run-llm').rewriteFive(input({attemptHistoryMode:true})),e=>e instanceof f.GrokHttpError&&e.status===status));
  assert.equal(calls,1);assert.deepEqual(f.waits,[]);
 }
});
test('actual Grok transport cancellation and network ambiguity do not become content retries',async()=>{
 for(const cancelled of [true,false]){
  const controller=new AbortController(),f=fixture();let calls=0;
  await withHttp(f,async()=>{calls++;if(cancelled)controller.abort();throw Error('transport closed');},async()=>assert.rejects(f.load('auto-run-llm').rewriteFive(input({attemptHistoryMode:true,signal:controller.signal})),e=>e instanceof f.GrokLlmError&&e.code===(cancelled?'cancelled':'network-error')));
  assert.equal(calls,1);assert.deepEqual(f.waits,[]);
 }
});
test('Grok typed timeout is propagated without a second operation',async()=>{
 const f=fixture(),error=new f.GrokLlmError('timeout','Grok调用超时');let calls=0;
 await assert.rejects(f.retryRewriteDraft(1,async()=>{calls++;throw error;}),e=>e===error);assert.equal(calls,1);assert.deepEqual(f.waits,[]);
});
test('cancellation during Grok cooldown prevents the next actual HTTP call',async()=>{
 const controller=new AbortController(),f=fixture({onDelay:async()=>controller.abort()});let calls=0;
 await withHttp(f,async()=>{calls++;return new Response('{}',{status:429});},async()=>assert.rejects(f.load('auto-run-llm').rewriteFive(input({attemptHistoryMode:true,signal:controller.signal})),e=>e.name==='AbortError'));
 assert.equal(calls,1);assert.deepEqual(f.waits,[30000]);
});
