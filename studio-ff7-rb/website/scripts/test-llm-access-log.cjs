/* eslint-disable @typescript-eslint/no-require-imports */
// 实际Postgres回滚测试：替换供应商HTTP响应，不调用任何收费模型，不遗留测试日志。
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),Module=require('module'),ts=require('typescript');
const sql=require('postgres')(process.env.DATABASE_URL||'');
const root=path.join(__dirname,'../src/lib');
function load(file,overrides){const m=new Module(__filename);m.require=id=>overrides[id]??(id.startsWith('./')?load(id.slice(2),overrides):require(id));m._compile(ts.transpileModule(fs.readFileSync(path.join(root,file+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,path.join(root,file+'.ts'));return m.exports;}
const rollback=Error('rollback-only');
(async()=>{
 try{await sql.begin(async tx=>{
  const store=load('llm-access-log',{'./db':{sql:tx}}),metrics=load('llm-metrics',{'./llm-access-log':store,'./llm-metrics-summary':require('../src/lib/llm-metrics-summary.ts')});
  const client=load('auto-run-llm',{'./llm-metrics':metrics});
  const fakeEndpoint=new URL('https://example.invalid/v1/chat/completions?api_key=secret#token');fakeEndpoint.username='user';fakeEndpoint.password='password';
  assert.equal(store.safeLlmEndpoint(fakeEndpoint.toString()),'https://example.invalid/v1/chat/completions');
  const invocationId=crypto.randomUUID();
  const body={model:'replay-source',messages:[{role:'system',content:'逐字保留{{括号}}与\n换行'},{role:'user',content:'原文：啊！\n不要丢字。'}],temperature:.4,max_tokens:4096,thinking:{type:'disabled'},response_format:{type:'json_object'},stream:false};
  const payload={id:'response-id',model:'actual-provider',choices:[{message:{content:'正文'.repeat(3000),reasoning_content:'思考'.repeat(3000)}}],usage:{prompt_tokens:400,completion_tokens:80,total_tokens:480,prompt_tokens_details:{cached_tokens:10},completion_tokens_details:{reasoning_tokens:20}}};
  const original=global.fetch;
  global.fetch=async()=>{const [pending]=await tx`SELECT status,request_body FROM llm_access_logs WHERE invocation_id=${invocationId}`;assert.equal(pending.status,'pending');assert.deepEqual(pending.request_body,body);return new Response(JSON.stringify(payload),{headers:{'x-request-id':'request-id'}});};
  try{
   await client.loggedChatFetch('https://example.invalid/v1/chat/completions?key=secret',{method:'POST',headers:{authorization:'Bearer secret'},body:JSON.stringify(body)},{invocationId,task:'test-replay',attempt:1,promptKeys:['test.input'],stem:'TEST_ONLY'});
   const [row]=await tx`SELECT * FROM llm_access_logs WHERE invocation_id=${invocationId}`;
   assert.equal(row.status,'success');assert.deepEqual(row.request_body,body);assert.deepEqual(row.response_body,payload);assert.equal(row.response_raw,JSON.stringify(payload));assert.equal(row.output_text,payload.choices[0].message.content);assert.equal(row.reasoning_text,payload.choices[0].message.reasoning_content);assert.equal(Number(row.input_tokens),400);assert.equal(Number(row.output_tokens),80);assert.equal(Number(row.cached_tokens),10);assert.equal(row.endpoint,'https://example.invalid/v1/chat/completions');assert.equal(row.request_id,'request-id');assert.equal(row.auto_run_id,null);assert.equal(row.stem,'TEST_ONLY');assert.ok(row.completed_at);assert.doesNotMatch(JSON.stringify(row),/Bearer|api_key|key=secret/);
   global.fetch=async()=>new Response('supplier non-JSON failure',{status:503});
   await client.loggedChatFetch('https://example.invalid/v1/chat/completions',{method:'POST',body:JSON.stringify(body)},{invocationId,task:'test-replay',attempt:2,promptKeys:[],stem:'TEST_ONLY'});
   const [failed]=await tx`SELECT * FROM llm_access_logs WHERE invocation_id=${invocationId} AND attempt=2`;
   assert.equal(failed.status,'http-error');assert.equal(failed.response_raw,'supplier non-JSON failure');assert.equal(failed.response_body,null);assert.equal(failed.input_tokens,null);assert.equal(failed.output_tokens,null);
   console.log('PASS: actual database preserves replay request, full output/reasoning, raw errors, usage and pending→completed lifecycle; credentials excluded');
   const localInvocationId=crypto.randomUUID();let localCalls=0,localCancelled=false;
   const sse=o=>'data: '+JSON.stringify(o)+'\n\n';
   const good=sse({model:'local-model',choices:[{index:0,delta:{reasoning_content:'独立思考',content:'{\"ok\":true}'},finish_reason:'stop'}]})+sse({choices:[],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30,completion_tokens_details:{reasoning_tokens:4}}})+'data: [DONE]\n\n';
   global.fetch=async()=>{
    if(++localCalls===1)return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(sse({choices:[{index:0,delta:{content:'哈'.repeat(10)}}]})));},cancel(){localCancelled=true;}},{highWaterMark:0}),{headers:{'content-type':'text/event-stream'}});
    return new Response(good,{headers:{'content-type':'text/event-stream'}});
   };
   const streamed=await client.loggedChatFetch('https://local.invalid/v1/chat/completions',{method:'POST',body:JSON.stringify(body)},{invocationId:localInvocationId,task:'test-replay',attempt:1,promptKeys:[],stem:'TEST_ONLY',modelId:'self-hosted'},{retryDelayMs:0});
   assert.equal((await streamed.json()).choices[0].message.content,'{\"ok\":true}');assert.equal(localCancelled,true);
   const localRows=await tx`SELECT * FROM llm_access_logs WHERE invocation_id=${localInvocationId} ORDER BY attempt`;
   assert.deepEqual(localRows.map(r=>r.status),['repetition-detected','success']);
   assert.deepEqual(localRows.map(r=>r.attempt),[1,2]);assert.equal(localRows[0].input_tokens,null);assert.equal(localRows[0].output_tokens,null);
   assert.equal(localRows[0].response_body.stream_guard.repetition.repetitions,10);assert.equal(localRows[0].output_text,'哈'.repeat(10));
   assert.match(localRows[0].response_raw,/data:/);assert.equal(localRows[1].reasoning_text,'独立思考');assert.equal(Number(localRows[1].output_tokens),10);
   assert.equal(localRows[1].request_body.stream,true);assert.equal(localRows[1].request_body.stream_options.include_usage,true);
   assert.doesNotMatch(JSON.stringify(localRows),/Bearer|secret/);
   console.log('PASS: actual database preserves aborted SSE, repetition evidence, unknown partial usage and separately logged successful retry');

  }finally{global.fetch=original;}
  throw rollback;
 });}catch(error){if(error!==rollback)throw error;}
 const [{count}]=await sql`SELECT count(*)::int AS count FROM llm_access_logs WHERE task='test-replay' AND stem='TEST_ONLY'`;assert.equal(count,0);console.log('PASS: all test rows rolled back; no paid API calls');
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>sql.end());
