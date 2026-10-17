/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {setTimeout:sleep}=require('node:timers/promises');
const {loadLlmModule}=require('./llm-client-test-loader.cjs');
const {RepetitionDetector}=require('./llm-repetition.ts');
const {consumeLlmSse}=require('./llm-sse.ts');
const enc=new TextEncoder();
const frame=o=>'data: '+JSON.stringify(o)+'\r\n\r\n';
const delta=(content,reasoning)=>frame({model:'local-test',choices:[{index:0,delta:{...(content===undefined?{}:{content}),...(reasoning===undefined?{}:{reasoning_content:reasoning})}}]});
function completed(content='{"text":"正常"}',thinking='正常思考'){
 return ': heartbeat\r\n\r\n'+delta(undefined,thinking)+delta(content)+frame({choices:[{index:0,delta:{},finish_reason:'stop'}]})+frame({choices:[],usage:{prompt_tokens:12,completion_tokens:9,total_tokens:21,completion_tokens_details:{reasoning_tokens:4}}})+'data: [DONE]\r\n\r\n';
}
function stream(text,split=7,onCancel=()=>{}){
 const bytes=enc.encode(text);let offset=0;
 return new ReadableStream({pull(c){if(offset===bytes.length){c.close();return;}c.enqueue(bytes.slice(offset,offset+split));offset=Math.min(bytes.length,offset+split);},cancel:onCancel},{highWaterMark:0});
}
function response(text,split=7,cancel){return new Response(stream(text,split,cancel),{headers:{'content-type':'text/event-stream','x-request-id':'stream-1'}});}
function client(overrides={}){
 const requests=[],records=[];
 const metrics={beginLlmCall:async r=>{requests.push(r);return String(requests.length);},recordLlmCall:async r=>records.push(r),...overrides};
 return {...loadLlmModule('llm-self-hosted',metrics),requests,records,metrics};
}
const body=()=>JSON.stringify({model:'local-test',messages:[{role:'user',content:'台词'}],response_format:{type:'json_object'}});
const meta=()=>({invocationId:crypto.randomUUID(),task:'test-local',attempt:1,promptKeys:['test.input']});
const opts={retryDelayMs:0};
async function mocked(fetcher,fn){const old=global.fetch;global.fetch=fetcher;try{return await fn();}finally{global.fetch=old;}}

test('ten exact consecutive repetitions stop, nine and five laughs do not; network chunks are irrelevant',()=>{
 const phrase='继续检查这段内容。';
 for(const chunkSize of [1,2,7,1024]){
  const d=new RepetitionDetector();let hit=null;const text='前言'+phrase.repeat(10)+'后文';
  for(let i=0;i<text.length&&!hit;i+=chunkSize)hit=d.push(text.slice(i,i+chunkSize));
  assert.equal(hit.repetitions,10);assert.equal(hit.pattern,phrase);assert.equal(hit.endOffset,2+[...phrase].length*10);
 }
 assert.equal(new RepetitionDetector().push(phrase.repeat(9)),null);
 assert.equal(new RepetitionDetector().push('哈哈哈哈哈'),null);
 assert.equal(new RepetitionDetector().push('哈'.repeat(10)).kind,'text');
 assert.equal(new RepetitionDetector().push('abXabYabZabQabWabEabRabTabUabI'),null);
});
test('mixed whitespace, emoji split into surrogates, and patterns up to 512 characters are detected',()=>{
 const d=new RepetitionDetector();assert.equal(d.push(' \n\t \r\n\t \n'),null);assert.equal(d.push('\t').kind,'whitespace');
 const emoji=new RepetitionDetector();let hit;for(const unit of '😀'.repeat(10).split(''))hit=emoji.push(unit);assert.equal(hit.pattern,'😀');
 const phrase=Array.from({length:512},(_,i)=>String.fromCharCode(0x4e00+i)).join('');assert.equal(new RepetitionDetector().push(phrase.repeat(10)).patternLength,512);
});
test('SSE handles split UTF8, CRLF, lone CR, multiline data and ignores heartbeats',async()=>{
 const events=[],raw=[];const text=': ping\r\rdata: {"a":\rdata: "中文😀"}\r\rdata: [DONE]\r\n\r\n';
 let cancelled=0;await consumeLlmSse(stream(text+': unread\n\n',1,()=>cancelled++),s=>{events.push(s);return s!=='[DONE]';},s=>raw.push(s));
 assert.deepEqual(events,['{"a":\n"中文😀"}','[DONE]']);assert.equal(raw.join(''),text);assert.equal(cancelled,1);
});
test('success returns a compatible completion and saves actual SSE, split reasoning, usage and streamed request',()=>mocked(async(_u,init)=>{
 const sent=JSON.parse(init.body);assert.equal(sent.stream,true);assert.deepEqual(sent.stream_options,{include_usage:true});return response(completed('{"text":"中文😀"}'));
},async()=>{
 const c=client(),r=await c.loggedSelfHostedChatFetch('http://local.invalid', {body:body()},meta(),opts),p=await r.json();
 assert.equal(p.choices[0].message.content,'{"text":"中文😀"}');assert.equal(p.choices[0].message.reasoning_content,'正常思考');
 assert.equal(c.records[0].status,'success');assert.equal(c.records[0].usage.completion_tokens,9);assert.match(c.records[0].responseRaw,/data:/);assert.equal(c.records[0].requestId,'stream-1');
 assert.equal(c.requests[0].requestBody.stream,true);assert.equal(r.headers.get('content-type'),'application/json');
}));
for(const channel of ['content','reasoning'])test(`ten ${channel} repeats abort and cancel the first stream, then retry the original request`,async()=>{
 const c=client(),sent=[],signals=[];let cancelled=0,calls=0;
 await mocked(async(_u,init)=>{
  sent.push(JSON.parse(init.body));signals.push(init.signal);
  if(++calls===1)return response((channel==='content'?delta('短语。'.repeat(10)):delta(undefined,'短语。'.repeat(10)))+delta('绝对不能继续读取'),13,()=>cancelled++);
  return response(completed());
 },async()=>{const r=await c.loggedSelfHostedChatFetch('http://local.invalid',{body:body()},meta(),opts);assert.equal((await r.json()).choices[0].message.content,'{"text":"正常"}');});
 assert.equal(calls,2);assert.equal(cancelled,1);assert.equal(signals[0].aborted,true);assert.equal(signals[1].aborted,false);
 assert.deepEqual(sent[0],sent[1]);assert.deepEqual(c.records.map(r=>r.status),['repetition-detected','success']);
 assert.deepEqual(c.requests.map(r=>r.attempt),[1,2]);assert.equal(c.requests[0].invocationId,c.requests[1].invocationId);
 assert.equal(c.records[0].responseBody.stream_guard.channel,channel);assert.equal(c.records[0].responseBody.stream_guard.repetition.repetitions,10);
 assert.equal(c.records[0].usage,undefined);assert.doesNotMatch(c.records[0].outputText,/绝对不能继续读取/);
});
test('historical malformed JSON followed by mixed blank output is stopped on ten blanks rather than the token limit',()=>mocked(async()=>response(delta('{"text":"未来我们五台再见吧！","reason":"增加"')+Array.from({length:20},(_,i)=>delta([' ','\t','\n'][i%3])).join(''),3),async()=>{
 const c=client();await assert.rejects(c.loggedSelfHostedChatFetch('http://local.invalid',{body:body()},meta(),{...opts,maxAttempts:1}),e=>e.code==='repetition-detected');
 assert.equal(c.records[0].responseBody.stream_guard.repetition.kind,'whitespace');assert.equal(c.records[0].responseBody.stream_guard.repetition.endOffset<100,true);
}));
test('separate channels do not add nine repeated characters into a false total of eighteen',()=>mocked(async()=>response(delta(undefined,'哈'.repeat(9))+delta('{"text":"'+'哈'.repeat(9)+'"}')+frame({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n'),async()=>{
 const c=client();await c.loggedSelfHostedChatFetch('http://local.invalid',{body:body()},meta(),opts);assert.equal(c.records[0].status,'success');
}));
test('all three attempts stop at repetition and throw without returning a partial completion',()=>mocked(async()=>response(delta('哈'.repeat(10))),async()=>{
 const c=client();await assert.rejects(c.loggedSelfHostedChatFetch('http://local.invalid',{body:body()},meta(),opts),e=>e.code==='repetition-detected'&&e.attempts===3);
 assert.equal(c.requests.length,3);assert.ok(c.records.every(r=>r.status==='repetition-detected'));
}));
for(const [name,bad,status]of [
 ['cut off SSE',delta('{"text":"完整但未完成协议"}'),'stream-error'],
 ['bad event','data: {bad}\n\n','stream-error'],
 ['provider error','data: {"error":{"message":"provider problem"}}\n\n','stream-error'],
 ['length',delta('{"text":"半截')+frame({choices:[{index:0,delta:{},finish_reason:'length'}]})+'data: [DONE]\n\n','truncated'],
 ['invalid JSON',completed('{broken'),'invalid-json'],
 ['array instead of object',completed('[]'),'invalid-json'],
 ['empty content',completed(''),'invalid-response'],
 ['server repetition',frame({choices:[{index:0,delta:{},finish_reason:'repetition'}]}),'repetition-detected'],
])test(name+' is logged as failure and retried',async()=>{
 let calls=0;const c=client();await mocked(async()=>response(++calls===1?bad:completed()),()=>c.loggedSelfHostedChatFetch('http://local.invalid',{body:body()},meta(),opts));
 assert.deepEqual(c.records.map(r=>r.status),[status,'success']);
});
test('HTTP 400 is not retried; 429 is retried and raw provider error remains available',async()=>{
 const c=client();let calls=0;
 await mocked(async()=>{calls++;return new Response('bad request',{status:400});},()=>assert.rejects(c.loggedSelfHostedChatFetch('http://local.invalid',{body:body()},meta(),opts),e=>e.code==='http-error'));
 assert.equal(calls,1);assert.equal(c.records[0].responseRaw,'bad request');
 await mocked(async()=>++calls===2?new Response('rate limited',{status:429}):response(completed()),()=>c.loggedSelfHostedChatFetch('http://local.invalid',{body:body()},meta(),opts));
 assert.deepEqual(c.records.slice(1).map(r=>r.status),['http-error','success']);
});
function stalled(init,{heartbeat=false,progress=false}={}){
 let interval;return new Response(new ReadableStream({start(c){
  interval=setInterval(()=>c.enqueue(enc.encode(progress?delta(''+Date.now()+Math.random()):heartbeat?': heartbeat\n\n':'')),3);
  init.signal.addEventListener('abort',()=>{clearInterval(interval);c.error(Error('aborted'));},{once:true});
 },cancel(){clearInterval(interval);}},{highWaterMark:0}),{headers:{'content-type':'text/event-stream'}});
}
test('external abort cancels one attempt and does not retry',()=>mocked(async(_u,init)=>stalled(init),async()=>{
 const c=client(),ac=new AbortController();setTimeout(()=>ac.abort(),15);
 await assert.rejects(c.loggedSelfHostedChatFetch('http://local.invalid',{body:body(),signal:ac.signal},meta(),opts),e=>e.code==='cancelled');
 assert.equal(c.records.length,1);assert.equal(c.records[0].status,'cancelled');
}));
test('heartbeats do not mask idle timeout and a total deadline still bounds ongoing progress',async()=>{
 for(const progress of [false,true]){
  const c=client();await mocked(async(_u,init)=>stalled(init,{heartbeat:!progress,progress}),()=>assert.rejects(c.loggedSelfHostedChatFetch('http://local.invalid',{body:body()},meta(),{maxAttempts:1,retryDelayMs:0,timeoutMs:progress?30:500,idleTimeoutMs:progress?500:20}),e=>e.code==='timeout'));
  assert.equal(c.records[0].status,'timeout');
 }
});
test('database failure prevents request; completion-log failure prevents a hidden retry',async()=>{
 let calls=0;
 await mocked(async()=>{calls++;return response(completed());},async()=>{
  const c=client({beginLlmCall:async()=>{throw Error('DB unavailable');}});
  await assert.rejects(c.loggedSelfHostedChatFetch('http://local.invalid',{body:body()},meta(),opts),/DB unavailable/);assert.equal(calls,0);
  const d=client({recordLlmCall:async()=>{throw Error('DB write failed');}});
  await assert.rejects(d.loggedSelfHostedChatFetch('http://local.invalid',{body:body()},meta(),opts),/DB write failed/);assert.equal(calls,1);
 });
});
test('concurrent invocations share four slots and queued cancellation never starts an HTTP call',async()=>{
 const c=client(),gates=[];let active=0,peak=0,calls=0;
 await mocked(async()=>{calls++;active++;peak=Math.max(peak,active);await new Promise(r=>gates.push(r));active--;return response(completed());},async()=>{
  const running=Array.from({length:4},()=>c.loggedSelfHostedChatFetch('http://local.invalid',{body:body()},meta(),opts));
  for(let i=0;i<100&&calls<4;i++)await sleep(1);assert.equal(calls,4);
  const ac=new AbortController();const cancelled=c.loggedSelfHostedChatFetch('http://local.invalid',{body:body(),signal:ac.signal},meta(),opts);ac.abort();await assert.rejects(cancelled,e=>e.code==='cancelled');assert.equal(calls,4);
  gates.splice(0).forEach(r=>r());await Promise.all(running);
 });
 assert.equal(peak,4);assert.equal(c.requests.length,4);
});
test('generic model registry exposes self-hosted explicitly while preserving primary as default',async()=>{
 const c=client(),api=loadLlmModule('llm-chat-client',c.metrics);const names=['SELF_HOSTED_LLM_URL','SELF_HOSTED_LLM_MODEL','SELF_HOSTED_LLM_KEY','REWRITE_LLM_URL','REWRITE_LLM_KEY'],old=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{SELF_HOSTED_LLM_URL:'http://local.invalid/v1',SELF_HOSTED_LLM_MODEL:'local-model',SELF_HOSTED_LLM_KEY:'private-local',REWRITE_LLM_URL:'http://cloud.invalid/v1',REWRITE_LLM_KEY:'private-cloud'});
 try{
  await mocked(async(url,init)=>{const b=JSON.parse(init.body);if(url.includes('local')){assert.equal(b.temperature,1);assert.equal(b.reasoning_effort,'medium');assert.equal(b.chat_template_kwargs.enable_thinking,true);assert.equal(b.max_completion_tokens,16384);assert.match(b.messages[0].content,/0.123/);assert.doesNotMatch(b.messages[0].content,/123456/);return response(completed());}assert.equal(b.stream,false);assert.deepEqual(b.thinking,{type:'disabled'});return new Response(JSON.stringify({choices:[{message:{content:'{}'}}]}));},async()=>{
   await api.callChatCompletion({modelId:'self-hosted',messages:[{role:'user',content:'比0.123456'}],selfHosted:opts});
   await api.callChatCompletion({messages:[{role:'user',content:'旧流程'}]});
  });
  assert.doesNotMatch(JSON.stringify(c.records),/private-local|private-cloud/);assert.equal(api.CHAT_MODELS.length,3);
 }finally{for(const k of names)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}
});

test('real HTTP stream is closed on repetition and the server observes cancellation before the retry completes',async()=>{
 const http=require('node:http');const c=client();let calls=0,firstClosed=false,interval;
 const server=http.createServer((req,res)=>{
  req.resume();const attempt=++calls;res.writeHead(200,{'content-type':'text/event-stream'});
  if(attempt===1){
   res.on('close',()=>{firstClosed=true;clearInterval(interval);});
   res.write(delta('哈'.repeat(10)));interval=setInterval(()=>res.write(delta('还在生成')),5);
  }else res.end(completed());
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const r=await c.loggedSelfHostedChatFetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',body:body(),headers:{'content-type':'application/json'}},meta(),{...opts,retryDelayMs:10});
  assert.equal((await r.json()).choices[0].message.content,'{"text":"正常"}');assert.equal(calls,2);
  for(let i=0;i<100&&!firstClosed;i++)await sleep(1);assert.equal(firstClosed,true);
  assert.deepEqual(c.records.map(r=>r.status),['repetition-detected','success']);
 }finally{clearInterval(interval);server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('reasoning aliases are supported, an empty primary alias falls back, and duplicate aliases are not counted twice',()=>mocked(async()=>response(
 frame({choices:[{index:0,delta:{reasoning_content:'',reasoning:'兼容思考'}}]})+
 frame({choices:[{index:0,delta:{reasoning_content:'哈'.repeat(9),reasoning:'哈'.repeat(9)}}]})+
 delta('{"ok":true}')+frame({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n'),async()=>{
 const c=client(),r=await c.loggedSelfHostedChatFetch('http://local.invalid',{body:body()},meta(),opts);
 assert.equal((await r.json()).choices[0].message.reasoning_content,'兼容思考'+'哈'.repeat(9));assert.equal(c.records[0].status,'success');
}));
