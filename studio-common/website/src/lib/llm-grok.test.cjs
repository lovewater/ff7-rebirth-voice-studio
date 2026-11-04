/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const env={GROK_LLM_URL:'https://grok.invalid/v1',GROK_LLM_KEY:'grok-private-secret',GROK_LLM_MODEL:'grok-4.7',REWRITE_LLM_URL:'https://glm.invalid/v1',REWRITE_LLM_KEY:'glm-private-secret',REWRITE_LLM_MODEL:'glm-5.3',VOLCENGINE_LLM_URL:'https://plan.invalid/v3',VOLCENGINE_LLM_KEY:'plan-private-secret',VOLCENGINE_LLM_MODEL:'deepseek-v4.1-flash',SELF_HOSTED_LLM_URL:'https://local.invalid/v1',SELF_HOSTED_LLM_MODEL:'local-model',SELF_HOSTED_LLM_KEY:'local-private-secret'};
async function configured(fn){const before=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])),oldFetch=global.fetch;Object.assign(process.env,env);try{return await fn();}finally{global.fetch=oldFetch;for(const [k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;}}
function client(overrides={}){
 const cache=new Map(),requests=[],records=[],waits=[];
 function load(file){if(cache.has(file))return cache.get(file);const m=new Module(__filename);cache.set(file,m.exports);
  m.require=id=>id==='./llm-metrics'?{currentLlmStem:()=>undefined,beginLlmCall:async x=>{requests.push(x);return String(requests.length);},recordLlmCall:async x=>{records.push(x);},...overrides.metrics}:id==='./db'?{sql:async()=>[]}:id==='node:timers/promises'?{setTimeout:async(ms,value,options)=>{waits.push(ms);if(overrides.onDelay)await overrides.onDelay(ms,options);if(options?.signal?.aborted)throw new DOMException('cancelled','AbortError');return value;}}:id.startsWith('./')?load(id.slice(2)):require(id);
  m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/'+file+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,__dirname+'/'+file+'.ts');cache.set(file,m.exports);return m.exports;
 }
 return{...load('llm-chat-client'),grok:load('llm-grok'),context:load('llm-model-context'),requests,records,waits};
}
const reply=(content='{"ok":true}',model='grok-4.7',extra={})=>Response.json({model,choices:[{finish_reason:'stop',message:{content,reasoning_content:'low-effort reasoning'}}],usage:{prompt_tokens:12,completion_tokens:5,total_tokens:17},...extra});
const sseReply=()=>new Response('data: '+JSON.stringify({model:'local-model',choices:[{index:0,delta:{content:'{"ok":true}'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({model:'local-model',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});

test('all tasks default to Grok while primary remains official GLM and all four explicit connection IDs remain selectable',()=>{
 const c=client();assert.equal(c.DEFAULT_CHAT_MODEL,'grok');assert.deepEqual(c.CHAT_MODELS.map(x=>x.id),['grok','primary','volcengine','self-hosted']);assert.match(c.CHAT_MODELS.find(x=>x.id==='primary').name,/官方GLM/);
 for(const task of ['unspecified','manual-rewrite','script-rewrite','text-review','rhythm-pick','onomatopoeia-plan','subtitle-quotes','independent-translation-jp'])assert.equal(c.chatModelForTask(task),'grok');
 for(const model of ['grok','primary','volcengine','self-hosted'])assert.equal(c.chatModelForTask('any',model),model);
});
test('Grok sends its own model/key, low effort, business token cap and JSON format with no GLM no-thinking fields',()=>configured(async()=>{
 const c=client(),deadlines=[],oldTimeout=AbortSignal.timeout;let wire;
 AbortSignal.timeout=ms=>{deadlines.push(ms);return oldTimeout(ms);};
 global.fetch=async(url,init)=>{wire={url,headers:init.headers,body:JSON.parse(init.body)};return reply('{"text":"合成测试"}','grok-4.7-upstream');};
 try{const output=await c.callChatCompletion({messages:[{role:'user',content:'时长1.234567秒'}],maxTokens:731,json:true});assert.equal(output.content,'{"text":"合成测试"}');assert.equal(output.thinking,'low-effort reasoning');}
 finally{AbortSignal.timeout=oldTimeout;}
 assert.equal(wire.url,env.GROK_LLM_URL+'/chat/completions');assert.equal(wire.headers.authorization,'Bearer '+env.GROK_LLM_KEY);assert.equal(wire.body.model,'grok-4.7');assert.equal(wire.body.reasoning_effort,'low');assert.equal(wire.body.max_tokens,731);assert.deepEqual(wire.body.response_format,{type:'json_object'});assert.equal(wire.body.stream,false);
 assert.equal(wire.body.thinking,undefined);assert.equal(wire.body.chat_template_kwargs,undefined);assert.equal(wire.body.max_completion_tokens,undefined);assert.deepEqual(deadlines,[310000]);assert.match(wire.body.messages[0].content,/1\.235/);
 assert.equal(c.requests[0].modelId,'grok');assert.deepEqual(c.requests[0].requestBody,wire.body);assert.equal(c.records[0].model,'grok-4.7-upstream');assert.doesNotMatch(JSON.stringify([...c.requests,...c.records]),/grok-private-secret|glm-private-secret|plan-private-secret|authorization/i);
}));
test('Grok plain text and per-call timeout remain explicit; missing Grok model uses grok-4.7',()=>configured(async()=>{
 delete process.env.GROK_LLM_MODEL;const c=client(),oldTimeout=AbortSignal.timeout,deadlines=[];let body;
 AbortSignal.timeout=ms=>{deadlines.push(ms);return oldTimeout(ms);};global.fetch=async(_u,init)=>{body=JSON.parse(init.body);return reply('plain');};
 try{await c.callChatCompletion({messages:[],json:false,timeoutMs:321,maxTokens:17});}finally{AbortSignal.timeout=oldTimeout;}
 assert.equal(body.model,'grok-4.7');assert.equal(body.max_tokens,17);assert.equal(body.response_format,undefined);assert.deepEqual(deadlines,[321]);
}));
test('four connections use separate configuration and bodies concurrently; explicit primary and self-hosted behavior stay intact',()=>configured(async()=>{
 const c=client(),seen=[];
 global.fetch=async(url,init)=>{const body=JSON.parse(init.body);seen.push({url,headers:init.headers,body});return url.includes('local.invalid')?sseReply():reply('{}',body.model);};
 await Promise.all(['grok','primary','volcengine','self-hosted'].map(modelId=>c.callChatCompletion({modelId,messages:[],attempts:1,selfHosted:{maxAttempts:1}})));
 const grok=seen.find(x=>x.url.includes('grok.invalid')),glm=seen.find(x=>x.url.includes('glm.invalid')),plan=seen.find(x=>x.url.includes('plan.invalid')),local=seen.find(x=>x.url.includes('local.invalid'));
 assert.equal(grok.headers.authorization,'Bearer '+env.GROK_LLM_KEY);assert.equal(glm.headers.authorization,'Bearer '+env.REWRITE_LLM_KEY);assert.equal(plan.headers.authorization,'Bearer '+env.VOLCENGINE_LLM_KEY);assert.equal(local.headers.authorization,'Bearer '+env.SELF_HOSTED_LLM_KEY);
 assert.deepEqual(glm.body.thinking,{type:'disabled'});assert.deepEqual(plan.body.thinking,{type:'disabled'});assert.equal(local.body.stream,true);assert.equal(local.body.chat_template_kwargs.enable_thinking,true);assert.equal(local.body.reasoning_effort,'medium');assert.equal(grok.body.reasoning_effort,'low');
 assert.doesNotMatch(JSON.stringify([...c.requests,...c.records]),/private-secret/);
}));
test('concurrent AsyncLocalStorage model scopes stay isolated and explicit calls take priority over inherited scopes',()=>configured(async()=>{
 const c=client(),seen=[];global.fetch=async(url,init)=>{seen.push({url,model:JSON.parse(init.body).model});await new Promise(r=>setTimeout(r,url.includes('grok')?8:1));return reply('{}',JSON.parse(init.body).model);};
 await Promise.all([c.context.withChatModel('primary',async()=>{await new Promise(r=>setTimeout(r,2));assert.equal(c.chatModelForTask(),'primary');await c.callChatCompletion({messages:[]});await c.callChatCompletion({messages:[],modelId:'grok'});}),c.context.withChatModel('grok',async()=>{assert.equal(c.chatModelForTask(),'grok');await c.callChatCompletion({messages:[]});})]);
 assert.equal(seen.filter(x=>x.model==='glm-5.3').length,1);assert.equal(seen.filter(x=>x.model==='grok-4.7').length,2);assert.equal(c.chatModelForTask(),'grok');
}));
test('missing Grok credentials fail before logs/HTTP and never fall back to configured GLM, plan or self-hosted',()=>configured(async()=>{
 const c=client();delete process.env.GROK_LLM_KEY;assert.equal(c.chatModelConfigured('grok'),false);assert.equal(c.chatModelConfigured('primary'),true);let sent=0;global.fetch=async()=>{sent++;return reply();};
 await assert.rejects(c.callChatCompletion({messages:[]}),/尚未配置Grok/);assert.equal(sent,0);assert.equal(c.requests.length,0);
}));
test('a malformed unrelated provider config cannot alter explicit Grok/GLM routes; credential-bearing Grok URLs are rejected without logging',()=>configured(async()=>{
 const c=client();global.fetch=async(_u,init)=>reply('{}',JSON.parse(init.body).model);
 process.env.VOLCENGINE_LLM_MODEL='invalid model with spaces';await c.callChatCompletion({messages:[],modelId:'grok'});
 process.env.GROK_LLM_URL='https://user@grok.invalid/v1?key=secret';await c.callChatCompletion({messages:[],modelId:'primary'});
 const before=c.requests.length;await assert.rejects(c.callChatCompletion({messages:[],modelId:'grok'}),/Grok接口地址不允许/);assert.equal(c.requests.length,before);assert.doesNotMatch(JSON.stringify(c.requests),/user:secret|key=secret/);
}));
for(const status of [408,429,500,502,503,599])test('Grok HTTP '+status+' retries the same bounded invocation/body, after proxy cooldown',()=>configured(async()=>{
 const c=client();let count=0;global.fetch=async(url)=>{assert.ok(url.includes('grok.invalid'));return ++count===1?new Response('{"error":"temporary"}',{status}):reply();};
 await c.callChatCompletion({messages:[],attempts:2});assert.equal(count,2);assert.deepEqual(c.requests.map(x=>x.attempt),[1,2]);assert.equal(c.requests[0].invocationId,c.requests[1].invocationId);assert.deepEqual(c.requests[0].requestBody,c.requests[1].requestBody);assert.deepEqual(c.records.map(x=>x.status),['http-error','success']);assert.deepEqual(c.waits,[status===429?30000:15000]);
}));
for(const status of [400,401,403,404])test('Grok HTTP '+status+' fails once without provider fallback',()=>configured(async()=>{
 const c=client();let count=0;global.fetch=async(url)=>{count++;assert.ok(url.includes('grok.invalid'));return new Response('{}',{status});};await assert.rejects(c.callChatCompletion({messages:[],attempts:3}),new RegExp('Grok返回 HTTP '+status));assert.equal(count,1);assert.equal(c.waits.length,0);
}));
test('Grok caps repeated 503 at three attempts and delays 15/30s rather than exhausting retries inside account cooldown',()=>configured(async()=>{
 const c=client();global.fetch=async()=>new Response('{}',{status:503});await assert.rejects(c.callChatCompletion({messages:[],attempts:10}),/Grok返回 HTTP 503/);assert.equal(c.requests.length,3);assert.deepEqual(c.waits,[15000,30000]);
}));
test('Retry-After seconds and dates are respected with finite 60s cap; invalid values retain cooldown minimums',()=>{
 const {grokRetryDelayMs:wait}=client().grok,now=Date.parse('2026-11-04T00:00:00Z');
 assert.equal(wait(503,1,null,now),15000);assert.equal(wait(503,2,null,now),30000);assert.equal(wait(429,1,null,now),30000);assert.equal(wait(429,2,null,now),60000);
 assert.equal(wait(503,1,'40',now),40000);assert.equal(wait(429,1,'999999',now),60000);assert.equal(wait(503,1,'Wed, 04 Nov 2026 00:00:45 GMT',now),45000);assert.equal(wait(503,1,'invalid',now),15000);assert.equal(wait(503,1,'-1',now),15000);
});
test('pre-aborted Grok never logs or sends; cancellation during HTTP aborts exactly one attempt',()=>configured(async()=>{
 const c=client(),before=new AbortController();before.abort();global.fetch=async()=>{throw Error('must not send');};await assert.rejects(c.callChatCompletion({messages:[],signal:before.signal}),e=>e.code==='cancelled');assert.equal(c.requests.length,0);
 const ac=new AbortController();let sent=0;global.fetch=async(_u,init)=>{sent++;return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('fetch aborted')),{once:true}));};
 const pending=c.callChatCompletion({messages:[],signal:ac.signal});setTimeout(()=>ac.abort(),10);await assert.rejects(pending,e=>e.code==='cancelled');assert.equal(sent,1);assert.equal(c.records[0].status,'cancelled');
}));
test('cancellation during Grok backoff never spends another retry and logs no fake attempt',()=>configured(async()=>{
 const ac=new AbortController(),c=client({onDelay:async()=>ac.abort()});global.fetch=async()=>new Response('{}',{status:503});await assert.rejects(c.callChatCompletion({messages:[],signal:ac.signal}),e=>e.name==='AbortError');assert.equal(c.requests.length,1);assert.equal(c.records[0].status,'http-error');
}));
test('Grok timeout/network errors are logged distinctly and not retried as HTTP 503',()=>configured(async()=>{
 const c=client();global.fetch=async(_u,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true}));
 const keepAlive=setTimeout(()=>{},50);try{await assert.rejects(c.callChatCompletion({messages:[],timeoutMs:5}),e=>e.code==='timeout');}finally{clearTimeout(keepAlive);}assert.equal(c.requests.length,1);assert.equal(c.records[0].status,'timeout');
 global.fetch=async()=>{throw Error(env.GROK_LLM_KEY);};await assert.rejects(c.callChatCompletion({messages:[]}),e=>e.code==='network-error');assert.equal(c.requests.length,2);assert.doesNotMatch(JSON.stringify(c.records),/grok-private-secret/);
}));
test('an echoed authentication key is redacted from raw/parsed/error/request-id logs while model identity remains real',()=>configured(async()=>{
 const c=client();global.fetch=async()=>new Response(JSON.stringify({model:'grok-4.7-upstream',error:{message:'bad key '+env.GROK_LLM_KEY}}),{status:401,headers:{'x-request-id':env.GROK_LLM_KEY}});
 await assert.rejects(c.callChatCompletion({messages:[]}),/HTTP 401/);assert.doesNotMatch(JSON.stringify([...c.requests,...c.records]),/grok-private-secret/);assert.match(c.records[0].responseRaw,/REDACTED/);assert.equal(c.records[0].model,'grok-4.7-upstream');assert.equal(c.records[0].requestId,'[REDACTED]');
}));
test('database failure prevents Grok HTTP; completion-log failure is not retried or hidden',()=>configured(async()=>{
 let sent=0;global.fetch=async()=>{sent++;return reply();};const before=client({metrics:{beginLlmCall:async()=>{throw Error('db unavailable');}}});await assert.rejects(before.callChatCompletion({messages:[]}),/db unavailable/);assert.equal(sent,0);
 const after=client({metrics:{recordLlmCall:async()=>{throw Error('db write failed');}}});await assert.rejects(after.callChatCompletion({messages:[]}),/db write failed/);assert.equal(sent,1);
}));

test('final Grok HTTP errors expose only typed status, retryability and normalized Retry-After metadata',()=>configured(async()=>{
 const c=client();for(const [status,retryAfter,retryable,normalized]of [[503,'45',true,'45'],[429,'Wed, 04 Nov 2026 00:00:45 GMT',true,'Wed, 04 Nov 2026 00:00:45 GMT'],[401,env.GROK_LLM_KEY,false,null]]){
  global.fetch=async()=>new Response('{}',{status,headers:{'retry-after':retryAfter}});
  await assert.rejects(c.callChatCompletion({messages:[],attempts:1}),error=>error instanceof c.grok.GrokHttpError&&error.status===status&&error.retryable===retryable&&error.retryAfter===normalized&&!JSON.stringify(error).includes(env.GROK_LLM_KEY));
 }
}));
test('Grok cancellation while consuming an HTTP-success response retains its typed error instead of becoming a JSON failure',()=>configured(async()=>{
 for(const timeout of [false,true]){
  const c=client(),ac=new AbortController();let sends=0;
  global.fetch=async()=>{sends++;return{ok:true,status:200,headers:new Headers(),clone:()=>({text:async()=>JSON.stringify({model:'grok-4.7',choices:[{message:{content:'{}'}}]})}),json:async()=>{ac.abort(timeout?new DOMException('timeout','TimeoutError'):undefined);throw Error('body aborted');}};};
  await assert.rejects(c.callChatCompletion({messages:[],signal:ac.signal}),error=>error instanceof c.grok.GrokLlmError&&error.code===(timeout?'timeout':'cancelled'));assert.equal(sends,1);
 }
}));
