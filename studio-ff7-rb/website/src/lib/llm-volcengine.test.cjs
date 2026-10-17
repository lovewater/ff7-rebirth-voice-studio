/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const {loadLlmModule}=require('./llm-client-test-loader.cjs');
const vars={REWRITE_LLM_URL:'https://primary.invalid/v1',REWRITE_LLM_KEY:'test-original-key',REWRITE_LLM_MODEL:'original-model',
 VOLCENGINE_LLM_URL:'https://plan.invalid/api/plan/v3',VOLCENGINE_LLM_KEY:'test-plan-key',VOLCENGINE_LLM_MODEL:'doubao-seed-2.1-pro'};
async function configured(fn){const old=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]])),oldFetch=global.fetch;Object.assign(process.env,vars);try{return await fn();}finally{global.fetch=oldFetch;for(const k of Object.keys(vars))if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}}
function client(){const requests=[],records=[];const api=loadLlmModule('llm-chat-client',{beginLlmCall:async r=>{requests.push(r);return String(requests.length);},recordLlmCall:async r=>records.push(r)});return{...api,requests,records};}
const reply=content=>new Response(JSON.stringify({model:'doubao-seed-2.1-pro',choices:[{finish_reason:'stop',message:{content,reasoning_content:''}}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}));
test('all authoring tasks use the plan; judging/formatting and unknown tasks keep primary; explicit override wins',()=>{
 const c=client();assert.deepEqual(c.CHAT_MODELS.map(m=>m.id),['primary','volcengine','self-hosted']);
 for(const task of ['script-rewrite','fallback-duration-rewrite','manual-rewrite','prompt-trial-script-rewrite'])assert.equal(c.chatModelForTask(task),'volcengine');
 for(const task of ['manual-selection','quick-pick','text-review','rhythm-pick','onomatopoeia-plan','missing-fragment-classification','missing-jp-subtitle-classification','subtitle-layout','subtitle-quotes','unknown'])assert.equal(c.chatModelForTask(task),'primary');
 assert.equal(c.chatModelForTask('script-rewrite','self-hosted'),'self-hosted');assert.equal(c.chatModelForTask('script-rewrite','primary'),'primary');
});
test('all rewrite paths send the exact plan endpoint/model/key with unchanged JSON contract, three decimals and separate logs',()=>configured(async()=>{
 const c=client(),seen=[];global.fetch=async(url,init)=>{seen.push({url,body:JSON.parse(init.body),headers:init.headers});return reply('{"text":"爷爷，你怎么来了？"}');};
 for(const task of ['script-rewrite','fallback-duration-rewrite','manual-rewrite'])await c.callChatCompletion({task,messages:[{role:'user',content:'实测3.141592s'}],stem:'TEST_ONLY',temperature:.55});
 for(const sent of seen){assert.equal(sent.url,vars.VOLCENGINE_LLM_URL+'/chat/completions');assert.equal(sent.headers.authorization,'Bearer '+vars.VOLCENGINE_LLM_KEY);assert.equal(sent.body.model,'doubao-seed-2.1-pro');assert.equal(sent.body.messages[0].content,'实测3.142s');assert.equal(sent.body.temperature,.55);assert.equal(sent.body.max_tokens,4096);assert.equal(sent.body.stream,false);assert.deepEqual(sent.body.thinking,{type:'disabled'});assert.deepEqual(sent.body.response_format,{type:'json_object'});assert.equal(sent.body.service_tier,undefined);assert.equal(sent.body.chat_template_kwargs,undefined);}
 assert.equal(c.requests.length,3);assert.ok(c.requests.every(r=>r.modelId==='volcengine'&&r.stem==='TEST_ONLY'));assert.ok(c.records.every(r=>r.status==='success'));assert.doesNotMatch(JSON.stringify([...c.requests,...c.records]),/test-plan-key|test-original-key|authorization/i);
}));
test('missing plan config fails before any HTTP request even when primary is available',()=>configured(async()=>{
 const c=client();delete process.env.VOLCENGINE_LLM_KEY;assert.equal(c.chatModelConfigured('volcengine'),false);assert.equal(c.chatModelConfigured('primary'),true);let sends=0;global.fetch=async()=>{sends++;return reply('{}');};
 await assert.rejects(c.callChatCompletion({task:'script-rewrite',messages:[]}),/火山 Agent Plan/);assert.equal(sends,0);assert.equal(c.requests.length,0);
}));
test('primary judging still uses only primary credentials after the rewrite provider is configured',()=>configured(async()=>{
 const c=client();global.fetch=async(url,init)=>{assert.equal(url,vars.REWRITE_LLM_URL+'/chat/completions');assert.equal(init.headers.authorization,'Bearer '+vars.REWRITE_LLM_KEY);assert.equal(JSON.parse(init.body).model,'original-model');return reply('{}');};
 await c.callChatCompletion({task:'text-review',messages:[]});assert.equal(c.requests[0].modelId,'primary');
}));
test('plan 401/403 fail without retry or silently falling back to another provider',()=>configured(async()=>{
 for(const status of [401,403]){const c=client();let sends=0;global.fetch=async(url)=>{sends++;assert.ok(url.includes('plan.invalid'));return new Response('{"error":{"code":"denied"}}',{status});};await assert.rejects(c.callChatCompletion({task:'script-rewrite',messages:[]}),new RegExp('HTTP '+status));assert.equal(sends,1);assert.equal(c.records[0].status,'http-error');}
}));
test('temporary plan errors retry the same snapshot and invocation; no nested retry when attempts is one',()=>configured(async()=>{
 const c=client();let sends=0;global.fetch=async()=>++sends===1?new Response('{}',{status:503}):reply('{"text":"可用稿"}');
 await c.callChatCompletion({task:'script-rewrite',messages:[],attempts:2});assert.equal(sends,2);assert.deepEqual(c.requests.map(r=>r.attempt),[1,2]);assert.equal(c.requests[0].invocationId,c.requests[1].invocationId);assert.deepEqual(c.requests[0].requestBody,c.requests[1].requestBody);
 global.fetch=async()=>{sends++;return new Response('{}',{status:503});};await assert.rejects(c.callChatCompletion({task:'script-rewrite',messages:[],attempts:1}),/HTTP 503/);assert.equal(sends,3);
}));
test('manual route really uses the common plan path for rewriting and primary for selection, retaining stem ownership',()=>configured(async()=>{
 const c=client(),route=new Module(__filename),seen=[];
 route.require=id=>{
  if(id==='@/lib/auto-run-llm')return{...c,rewriteChat:(messages,temperature,task,attempts,options)=>c.callChatCompletion({messages,temperature,task,attempts,...options})};
  if(id==='next/server')return{NextResponse:{json:Response.json}};
  if(id==='@/lib/db')return{sql:async()=>[{id:1,stem:'TEST_ONLY',name_zh:'测试',text_jp:'これはテストです',text_en:'Test',text_zh:'这是测试',dialogue_mode:'scene',subtitle_italic:false,kind:'对话'}]};
  if(id==='@/lib/tts-gpu')return{normalizeScript:t=>({ttsText:t})};
  if(id==='@/lib/subtitle-layout')return{subtitleLayout:t=>t};
  if(id==='@/lib/beats')return{NORMAL_JP_CN_RATIO:1.2};
  if(id==='@/lib/rewrite-prompt')return{REWRITE_COUNT:5,REWRITE_LIMIT:10,REWRITE_POLICY:'test',REWRITE_MIN:.9,REWRITE_MAX:1.1,parseRewrite:JSON.parse,rewriteMessages:()=>[{role:'user',content:'重写'}],performanceLabel:()=>'',rewriteBand:()=>({low:.9,high:1.1}),rewritePace:()=> '正常',samePerformance:()=>true,takeUntilBoundary:()=>({before:[],after:[]})};
  throw Error('unexpected require '+id);
 };
 route._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/../app/api/lines/[stem]/rewrite/route.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
 global.fetch=async(url)=>{if(url.endsWith('/beats'))return Response.json({results:[{jp:{status:'ok',units:12},cn:{units:10},normalizedRatio:1}]});seen.push(url);return reply(url.includes('plan.invalid')?'{"text":"测试改稿","situation":"测试","problem":"测试","plan":"测试"}':'{"selectedIndex":0,"reason":"测试"}');};
 assert.equal((await (await route.exports.GET()).json()).configured,true);
 for(const body of [{text:'这是测试',attempt:0},{text:'这是测试',action:'select',candidates:['这是测试']}]){
  const r=await route.exports.POST(new Request('http://test.invalid',{method:'POST',body:JSON.stringify(body)}),{params:Promise.resolve({stem:'TEST_ONLY'})});assert.equal(r.status,200,await r.clone().text());
 }
 assert.deepEqual(seen,[vars.VOLCENGINE_LLM_URL+'/chat/completions',vars.REWRITE_LLM_URL+'/chat/completions']);assert.ok(c.requests.every(r=>r.stem==='TEST_ONLY'));
}));
