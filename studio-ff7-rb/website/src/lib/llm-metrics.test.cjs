/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),{readFileSync}=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function metricsModule(){const rows=[],starts=[];const m=new Module(__filename);m.require=id=>id==='./db'?{sql:async(_strings,runId)=>rows.filter(r=>starts[Number(r.logId)-1]?.runId===runId)}:id==='./llm-metrics-summary'?require('./llm-metrics-summary.ts'):id==='./llm-access-log'?{insertLlmLog:async row=>{starts.push(row);return String(starts.length);},completeLlmLog:async row=>rows.push(row)}:require(id);m._compile(ts.transpileModule(readFileSync(`${__dirname}/llm-metrics.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,`${__dirname}/llm-metrics.ts`);return {...m.exports,rows,starts};}
const usage={prompt_tokens:10,completion_tokens:5,total_tokens:15};
const measurement={logId:'test-log',task:'script-rewrite',model:'test',attempt:1,startedAt:'2026-10-17T00:00:00Z',elapsedMs:1000,httpStatus:200,status:'success',usage};
test('API usage preserves absent fields as unknown and reports end-to-end throughput',()=>{
 const {llmUsageMetrics}=metricsModule();
 assert.deepEqual(llmUsageMetrics({prompt_tokens:100,completion_tokens:30,total_tokens:130,prompt_tokens_details:{cached_tokens:40},completion_tokens_details:{reasoning_tokens:0}},2000),{promptTokens:100,completionTokens:30,totalTokens:130,cachedTokens:40,reasoningTokens:0,endToEndOutputTokensPerSecond:15});
 for(const usage of [null,{}, {prompt_tokens:-1,completion_tokens:'30',total_tokens:Infinity}])assert.deepEqual(llmUsageMetrics(usage,0),{promptTokens:null,completionTokens:null,totalTokens:null,cachedTokens:null,reasoningTokens:null,endToEndOutputTokensPerSecond:null});
});
test('overlapping workflows isolate database request ownership and preserve the replay body',async()=>{
 const {withLlmMetrics,beginLlmCall,recordLlmCall,rows,starts}=metricsModule();
 const requestBody={model:'test',messages:[{role:'user',content:'完整私有台词'}],temperature:.4};
 const record=async()=>{const logId=await beginLlmCall({invocationId:crypto.randomUUID(),attempt:1,task:'script-rewrite',endpoint:'https://example.invalid/v1/chat/completions',requestBody,promptKeys:['test.input'],startedAt:measurement.startedAt});await recordLlmCall({...measurement,logId});};
 await Promise.all([withLlmMetrics('1','first',async()=>{await Promise.resolve();await record();}),withLlmMetrics('2','second',record)]);
 assert.equal(rows.length,2);for(const r of starts){assert.equal(r.stem,r.runId==='1'?'first':'second');assert.deepEqual(r.requestBody,requestBody);assert.equal(r.headers,undefined);}
 assert.ok(rows.every(row=>row.completionTokens===5));
});
function client(){const records=[],requests=[];const m=new Module(__filename);m.require=id=>id==='./auto-run-two-parts'?{performanceRewriteMessages:m=>m}:id==='./rewrite-number-hint'?{withRewriteNumberHint:m=>m}:id==='./rewrite-translation-reference'?{withTranslationReferences:async m=>m}:id==='./llm-chat-client'?require('./llm-client-test-loader.cjs').loadLlmChatClient(m.require):id==='./prompt-store'?require('./prompt-test-store.cjs'):id==='./llm-metrics'?{currentLlmStem:()=>undefined,beginLlmCall:async r=>{requests.push(r);return String(requests.length);},recordLlmCall:async r=>records.push(r)}:{};m._compile(ts.transpileModule(readFileSync(`${__dirname}/auto-run-llm.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,`${__dirname}/auto-run-llm.ts`);return{...m.exports,records,requests};}
async function configured(fn){const oldFetch=global.fetch,oldUrl=process.env.VOLCENGINE_LLM_URL,oldKey=process.env.VOLCENGINE_LLM_KEY;process.env.VOLCENGINE_LLM_URL='https://example.invalid/v1';process.env.VOLCENGINE_LLM_KEY='test-secret';try{await fn();}finally{global.fetch=oldFetch;if(oldUrl===undefined)delete process.env.VOLCENGINE_LLM_URL;else process.env.VOLCENGINE_LLM_URL=oldUrl;if(oldKey===undefined)delete process.env.VOLCENGINE_LLM_KEY;else process.env.VOLCENGINE_LLM_KEY=oldKey;}}
test('all outgoing message roles round data to three decimals and the replay log matches the wire',()=>configured(async()=>{
 const c=client();
 const content='{"ratio":0.9398496240601504,"spokenRatio":0.835421888053467} 实测3.680123s，差-0.00049秒，1.23456e-2；#38998，v1.23456，inference.example.invalid，https://host/1.23456?q=0.123456';
 const expected='{"ratio":0.94,"spokenRatio":0.835} 实测3.68s，差0秒，0.012；#38998，v1.23456，inference.example.invalid，https://host/1.23456?q=0.123456';
 const body={model:'model-1.23456',temperature:0.123456,messages:['system','user','assistant'].map(role=>({role,content}))};
 let sent;
 global.fetch=async(_url,init)=>{sent=JSON.parse(init.body);return new Response(JSON.stringify({choices:[{message:{content:'{"ratio":0.123456789}'}}]}));};
 await c.loggedChatFetch('https://example.invalid',{body:JSON.stringify(body)},{invocationId:crypto.randomUUID(),task:'precision-test',attempt:1,promptKeys:[]});
 assert.deepEqual(sent.messages.map(m=>m.content),[expected,expected,expected]);
 assert.deepEqual(c.requests[0].requestBody,sent);
 assert.equal(sent.temperature,body.temperature);assert.equal(sent.model,body.model);
 assert.equal(body.messages[0].content,content);
 assert.equal(c.records[0].outputText,'{"ratio":0.123456789}');
}));
test('client logs full expanded input, raw response, untruncated output/reasoning and actual usage without credentials',()=>configured(async()=>{
 const c=client(),output='正文'.repeat(3000),reasoning='思考'.repeat(3000);
 const payload={model:'provider-model',choices:[{message:{content:output,reasoning_content:reasoning}}],usage:{prompt_tokens:120,completion_tokens:15,total_tokens:135},provider_extra:{keep:true}};
 global.fetch=async(_url,init)=>{const body=JSON.parse(init.body);assert.equal(body.stream,false);assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.messages[0].promptKey,undefined);return new Response(JSON.stringify(payload),{headers:{'x-request-id':'request-1'}});};
 const result=await c.rewriteChat([{role:'user',content:'fallback',promptKey:'text-review.input',promptValues:{spoken:'private text',asr:'private text'}}],.1,'text-review');
 assert.deepEqual(result,{content:output,thinking:reasoning});assert.match(c.requests[0].requestBody.messages[0].content,/private text/);assert.deepEqual(c.requests[0].promptKeys,['text-review.input']);
 assert.equal(c.records[0].responseRaw,JSON.stringify(payload));assert.deepEqual(c.records[0].responseBody,payload);assert.equal(c.records[0].outputText,output);assert.equal(c.records[0].reasoningText,reasoning);assert.equal(c.records[0].usage.total_tokens,135);assert.equal(c.records[0].status,'success');assert.equal(c.records[0].model,'provider-model');assert.equal(c.records[0].requestId,'request-1');assert.doesNotMatch(JSON.stringify([...c.requests,...c.records]),/test-secret|authorization/i);
}));
test('each HTTP retry gets an independent row with the same invocation and request snapshot',()=>configured(async()=>{
 const c=client();let n=0;global.fetch=async()=>++n===1?new Response('provider error',{status:500}):new Response(JSON.stringify({choices:[{message:{content:'{}'}}]}));
 await c.rewriteChat([{role:'user',content:'原稿'}],.2,'retry-check',2);
 assert.equal(c.requests.length,2);assert.equal(c.requests[0].invocationId,c.requests[1].invocationId);assert.deepEqual(c.requests.map(r=>r.attempt),[1,2]);assert.deepEqual(c.records.map(r=>r.status),['http-error','success']);assert.equal(c.records[0].responseRaw,'provider error');assert.deepEqual(c.requests[0].requestBody,c.requests[1].requestBody);
}));
for(const [name,fetcher,status]of [
 ['invalid-json',async()=>new Response('not json'),'invalid-json'],
 ['truncated',async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'半截返回'}}]})),'truncated'],
 ['invalid-response',async()=>new Response(JSON.stringify({choices:[]})),'invalid-response'],
 ['network',async()=>{throw Error('internal-error-with-secret');},'network-error'],
])test(`failed ${name} call retains request and response evidence without leaking exception credentials`,()=>configured(async()=>{
 const c=client();global.fetch=fetcher;await assert.rejects(c.rewriteChat([{role:'user',content:'原文'}],.1,'failure',1));assert.equal(c.requests.length,1);assert.equal(c.records.length,1);assert.equal(c.records[0].status,status);assert.doesNotMatch(JSON.stringify(c.records),/internal-error-with-secret/);if(name==='truncated')assert.equal(c.records[0].outputText,'半截返回');
}));
test('request log failure prevents sending a paid request without a replay snapshot',()=>configured(async()=>{
 const c=client();let sends=0;global.fetch=async()=>{sends++;return new Response('{}');};
 // 用同一个生产客户端，只替换持久化边界。
 const m=new Module(__filename);m.require=id=>id==='./auto-run-two-parts'?{performanceRewriteMessages:m=>m}:id==='./rewrite-number-hint'?{withRewriteNumberHint:m=>m}:id==='./rewrite-translation-reference'?{withTranslationReferences:async m=>m}:id==='./llm-chat-client'?require('./llm-client-test-loader.cjs').loadLlmChatClient(m.require):id==='./prompt-store'?require('./prompt-test-store.cjs'):id==='./llm-metrics'?{currentLlmStem:()=>undefined,beginLlmCall:async()=>{throw Error('DB unavailable');},recordLlmCall:async()=>{}}:{};m._compile(ts.transpileModule(readFileSync(`${__dirname}/auto-run-llm.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,`${__dirname}/auto-run-llm.ts`);
 await assert.rejects(m.exports.rewriteChat([{role:'user',content:'原文'}]),/DB unavailable/);assert.equal(sends,0);assert.equal(c.requests.length,0);
}));
test('workflow aggregation stays isolated and includes calls after initial selection',async()=>{
 const {withLlmMetrics,currentLlmStem,beginLlmCall,recordLlmCall,llmMetricsForRun}=metricsModule();
 const record=async()=>{const logId=await beginLlmCall({task:'script-rewrite',attempt:1});await recordLlmCall({...measurement,logId});};
 assert.equal(currentLlmStem(),undefined);
 await Promise.all([
  withLlmMetrics('1','first',async()=>{assert.equal(currentLlmStem(),'first');assert.equal((await llmMetricsForRun('1')).tokens,null);await record();assert.equal((await llmMetricsForRun('1')).tokens.input,10);await Promise.resolve();assert.equal(currentLlmStem(),'first');await record();assert.equal((await llmMetricsForRun('1')).tokens.calls,2);}),
  withLlmMetrics('2','second',async()=>{assert.equal(currentLlmStem(),'second');await record();assert.equal((await llmMetricsForRun('2')).tokens.calls,1);})
 ]);
 assert.equal(currentLlmStem(),undefined);assert.equal((await llmMetricsForRun('1')).tokens.calls,2);assert.equal((await llmMetricsForRun('2')).tokens.calls,1);
});
