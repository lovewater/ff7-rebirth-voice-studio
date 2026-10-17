/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {retryRewriteDraft,RewriteDraftUnavailableError}=require('./auto-run-rewrite-retry.ts');
test('a failed draft can recover on the third retry without rerunning successful drafts',async()=>{
 let calls=0;const events=[];const result=await retryRewriteDraft(4,async()=>{if(++calls<4)throw Error('no text');return '可用稿';},async e=>events.push(e));
 assert.equal(result,'可用稿');assert.equal(calls,4);assert.deepEqual(events.map(e=>e.nextAttempt),[2,3,4]);assert.ok(events.every(e=>e.draftNumber===4));
});
test('four consecutive failures stop with a typed error after the first request plus three retries',async()=>{
 let calls=0;await assert.rejects(retryRewriteDraft(2,async()=>{calls++;throw Error('invalid JSON');}),e=>e instanceof RewriteDraftUnavailableError&&e.draftNumber===2&&e.attempts===4&&/invalid JSON/.test(e.message));assert.equal(calls,4);
});
test('valid first response consumes no retry',async()=>{let count=0;assert.equal(await retryRewriteDraft(1,async()=>++count),1);assert.equal(count,1);});
test('actual five-draft loop retries only the failed request, without nested HTTP retries or repeating successful drafts',async()=>{
 const {readFileSync}=require('node:fs'),Module=require('node:module'),ts=require('typescript');
 const retry=require('./auto-run-rewrite-retry.ts');const requests=[],failures=[];let measurements=0,secondFailures=0;
 const m=new Module(__filename);m.require=id=>{
  if(id==='./llm-chat-client')return require('./llm-client-test-loader.cjs').loadLlmChatClient(m.require);
  if(id==='./auto-run-rewrite-retry')return retry;
  if(id==='./prompt-store')return require('./prompt-test-store.cjs');
  if(id==='./llm-metrics')return{beginLlmCall:async()=> 'test-log',recordLlmCall:async()=>{}};
  if(id==='./beats')return{NORMAL_JP_CN_RATIO:1.33};
  if(id==='./tts-gpu')return{normalizeScript:text=>({ttsText:text})};
  if(id==='./auto-run-script-policy')return{performanceSegmentationHint:()=>''};
  if(id==='./rewrite-prompt')return{REWRITE_COUNT:5,rewritePace:()=> '正常',rewriteMessages:x=>[{role:'user',content:JSON.stringify({draft:x.attempt,previous:x.previous.length})}],parseRewrite:raw=>{const p=JSON.parse(raw);if(!p.text)throw Error('empty text');return{...p,raw};}};
  return{};
 };
 m._compile(ts.transpileModule(readFileSync(`${__dirname}/auto-run-llm.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,`${__dirname}/auto-run-llm.ts`);
 const originalFetch=global.fetch,oldUrl=process.env.REWRITE_LLM_URL,oldKey=process.env.REWRITE_LLM_KEY;
 process.env.REWRITE_LLM_URL='https://example.invalid/v1';process.env.REWRITE_LLM_KEY='test';
 global.fetch=async(_url,init)=>{const input=JSON.parse(JSON.parse(init.body).messages[0].content);requests.push(input);if(input.draft===1&&secondFailures++<3)return new Response('{}',{status:500});return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({text:'稿'+input.draft})}}]}));};
 try{await m.exports.rewriteFive({speaker:'',show:null,textJp:'',textEn:'',original:'原文',current:'当前稿',beats:{jp:{units:10}},before:[],after:[],jpAsr:{raw:{}},failNotes:[],measure:async()=>{measurements++;return{jp:{units:10},cn:{units:10},normalizedRatio:1};},onRetry:async e=>failures.push(e)});
 assert.equal(requests.length,8);assert.deepEqual(requests.map(r=>r.draft),[0,1,1,1,1,2,3,4]);assert.ok(requests.filter(r=>r.draft===1).every(r=>r.previous===1));assert.equal(measurements,10);assert.equal(failures.length,3);
 }finally{global.fetch=originalFetch;if(oldUrl===undefined)delete process.env.REWRITE_LLM_URL;else process.env.REWRITE_LLM_URL=oldUrl;if(oldKey===undefined)delete process.env.REWRITE_LLM_KEY;else process.env.REWRITE_LLM_KEY=oldKey;}
});
