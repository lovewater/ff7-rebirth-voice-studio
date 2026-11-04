const {randomUUID}=require('node:crypto');
const {parseAsr,Semaphore}=require('./policy.cjs');
const fs=require('node:fs/promises');
function safeEndpoint(value){const u=new URL(value);return `${u.protocol}//${u.host}${u.pathname}`;}
function endpoint(base,suffix){const u=new URL(base);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('invalid-service-endpoint');u.pathname=u.pathname.replace(/\/$/,'')+suffix;return u.toString();}
function createClients({config,sql,fetchImpl=fetch}){
 const asrSlots=new Semaphore(4),llmSlots=new Semaphore(4);
 const asrUrl=endpoint(config.asrUrl,config.asrUrl.replace(/\/$/,'').endsWith('/asr')?'':'/asr');
 const llmUrl=endpoint(config.llmUrl,config.llmUrl.replace(/\/$/,'').endsWith('/chat/completions')?'':'/chat/completions');
 async function asr(stem,file){return asrSlots.use(async()=>{
  const response=await fetchImpl(asrUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task_id:`remake-preprocess-${stem}-${randomUUID()}`,sample_audio:(await fs.readFile(file)).toString('base64'),language:'Japanese'}),signal:AbortSignal.timeout(config.timeoutMs)});
  if(!response.ok)throw Error('asr-http-'+response.status);
  return {...parseAsr(await response.json()),endpoint:safeEndpoint(asrUrl),model:'Qwen3-ASR-1.7B',completed_at:new Date().toISOString()};
 });}
 async function chat({messages,task,stem,promptKeys=[],maxTokens=512}){return llmSlots.use(async()=>{
  const request={model:config.llmModel,messages,temperature:.1,max_tokens:maxTokens,stream:false,response_format:{type:'json_object'},chat_template_kwargs:{enable_thinking:false}};
  const started=Date.now(),invocation=randomUUID();
  const [log]=await sql`INSERT INTO llm_access_logs(invocation_id,attempt,stem,task,endpoint,requested_model,prompt_keys,request_body,started_at) VALUES (${invocation},1,${stem??null},${task},${safeEndpoint(llmUrl)},${config.llmModel},${promptKeys},${sql.json(request)},now()) RETURNING id`;
  let raw='',value,status='network-error',httpStatus=null;
  try{
   const response=await fetchImpl(llmUrl,{method:'POST',headers:{'content-type':'application/json',...(config.llmApiKey?{Authorization:'Bearer '+config.llmApiKey}:{})},body:JSON.stringify(request),signal:AbortSignal.timeout(config.timeoutMs)});
   httpStatus=response.status;raw=await response.text();
   if(!response.ok){status='http-error';throw Error('llm-http-'+response.status);}
   try{value=JSON.parse(raw);}catch{status='invalid-json';throw Error('llm-invalid-json');}
   if(value.model!==config.llmModel){status='invalid-response';throw Error('llm-response-model-mismatch');}
   const choice=value.choices?.[0];
   const reasoningTokens=value.usage?.completion_tokens_details?.reasoning_tokens??value.usage?.reasoning_tokens??0;
   if(reasoningTokens>0||String(choice?.message?.reasoning_content??choice?.message?.reasoning??'').trim()){status='invalid-response';throw Error('llm-thinking-disabled-violation');}
   if(choice?.finish_reason==='length'){status='truncated';throw Error('llm-truncated');}
   if(typeof choice?.message?.content!=='string'){status='invalid-response';throw Error('llm-invalid-response');}
   try{JSON.parse(choice.message.content);}catch{status='invalid-json';throw Error('llm-output-invalid-json');}
   status='success';
   return {content:choice.message.content,logId:log.id,model:value.model??config.llmModel};
  } finally {
   const usage=value?.usage??null,msg=value?.choices?.[0]?.message;
   await sql`UPDATE llm_access_logs SET status=${status},response_model=${value?.model??null},http_status=${httpStatus},response_raw=${raw||null},response_body=${value?sql.json(value):null},output_text=${msg?.content??null},reasoning_text=${msg?.reasoning_content??msg?.reasoning??null},reasoning_tokens=${usage?.completion_tokens_details?.reasoning_tokens??usage?.reasoning_tokens??null},usage=${usage?sql.json(usage):null},input_tokens=${usage?.prompt_tokens??null},output_tokens=${usage?.completion_tokens??null},total_tokens=${usage?.total_tokens??null},elapsed_ms=${Date.now()-started},error=${status==='success'?null:status},completed_at=now() WHERE id=${log.id}`;
  }
 });}
 return {asr,chat};
}
module.exports={createClients,safeEndpoint,endpoint};
