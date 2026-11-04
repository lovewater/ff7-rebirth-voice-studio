#!/usr/bin/env node
// Remake-only ASR -> independent translations -> conservative original JP review. No TTS calls.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),Module=require('node:module');
const {promisify}=require('node:util'),{execFile}=require('node:child_process');
const execFileAsync=promisify(execFile);
const project=path.resolve(__dirname,'..'),common=path.resolve(project,'../studio-common/website');
const policy=require('./preprocess/policy.cjs');
const {createClients}=require('./preprocess/clients.cjs');
const {createStore}=require('./preprocess/store.cjs');
const {loadNames,compileNames,currentNames,nameGlossaryText,validateNames}=require('./preprocess/names.cjs');
const {hash,nonempty,parseIndependentTranslation,contextFor,contextualize,safeJpPath,parseDecisions,lockDecision,renderPrompt}=policy;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function loadConfig(env=process.env){
 const config={...env};
 if(config.REMAKE_PREPROCESS_ENV_FILE){for(const line of fs.readFileSync(config.REMAKE_PREPROCESS_ENV_FILE,'utf8').split(/\r?\n/)){const m=line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);if(!m)continue;if(!/^(REMAKE_PREPROCESS_|FF7_GAME_ID$|DATABASE_URL$|AUDIO_DATA_ROOT$)/.test(m[1]))throw Error('unexpected-preprocess-env-key');config[m[1]]=m[2].trim().replace(/^(['"])(.*)\1$/,'$2');}}
 if(config.FF7_GAME_ID!=='remake')throw Error('explicit-remake-game-id-required');
 let url;try{url=new URL(config.DATABASE_URL);}catch{throw Error('explicit-remake-database-required');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||decodeURIComponent(url.username)!=='ff7remake'||decodeURIComponent(url.pathname)!=='/studio_ff7_remake'||[...url.searchParams.keys()].some(k=>['user','username','database','db','dbname'].includes(k.toLowerCase())))throw Error('remake-database-role-mismatch');
 if(config.AUDIO_DATA_ROOT&&config.REMAKE_PREPROCESS_DATA_ROOT&&path.resolve(config.AUDIO_DATA_ROOT)!==path.resolve(config.REMAKE_PREPROCESS_DATA_ROOT))throw Error('conflicting-audio-data-roots');
 const dataRoot=path.resolve(config.REMAKE_PREPROCESS_DATA_ROOT||config.AUDIO_DATA_ROOT||path.join(project,'website/data'));
 if(config.REMAKE_PREPROCESS_CONCURRENCY&&config.REMAKE_PREPROCESS_CONCURRENCY!=='4')throw Error('preprocess-concurrency-must-be-four');
 let marker;try{marker=JSON.parse(fs.readFileSync(path.join(dataRoot,'.ff7-game.json'),'utf8'));}catch{throw Error('remake-audio-marker-required');}
 if(marker?.game_id!=='remake'||marker.database!=='studio_ff7_remake')throw Error('remake-audio-marker-mismatch');
 return {databaseUrl:config.DATABASE_URL,dataRoot,stateDir:path.resolve(config.REMAKE_PREPROCESS_STATE_DIR||path.join(project,'work/preprocess')),scopeFile:config.REMAKE_PREPROCESS_SCOPE_FILE,
  asrUrl:config.REMAKE_PREPROCESS_ASR_URL,llmUrl:config.REMAKE_PREPROCESS_LLM_URL,llmModel:config.REMAKE_PREPROCESS_LLM_MODEL,llmApiKey:config.REMAKE_PREPROCESS_LLM_API_KEY,
  timeoutMs:Number(config.REMAKE_PREPROCESS_TIMEOUT_MS||600000)};
}
function options(args){const opts={phase:'all',limit:Infinity,once:args.includes('--once'),prepare:args.includes('--prepare'),status:args.includes('--status')};for(const arg of args){if(arg.startsWith('--phase='))opts.phase=arg.slice(8);else if(arg.startsWith('--limit='))opts.limit=Number(arg.slice(8));else if(!['--once','--prepare','--status'].includes(arg))throw Error('unknown-argument');}if(!['all','preprocess','classify'].includes(opts.phase)||!(opts.limit>0)||(!Number.isInteger(opts.limit)&&opts.limit!==Infinity))throw Error('invalid-options');return opts;}
async function latestMessages(sql,specs){
 const keys=[...new Set(specs.map(x=>x.key))];
 const rows=await sql`SELECT DISTINCT ON(key) key,role,prompt,id::text FROM prompt_templates WHERE key=ANY(${keys}) AND enable=true ORDER BY key,updated_at DESC,id DESC`;
 return specs.map(spec=>{const p=rows.find(x=>x.key===spec.key);if(!p||p.role!==spec.role)throw Error('latest-enabled-prompt-missing');let content=renderPrompt(p.prompt,spec.values||{});
  // Only system game identity; source dialogue remains byte-for-byte as supplied.
  if(spec.role==='system')content=content.replace(/《最终幻想VII 重生》/g,'《最终幻想VII 重制版》').replace(/Final Fantasy VII Rebirth/g,'Final Fantasy VII Remake').replace(/《最终幻想7 重生》/g,'《最终幻想7 重制版》');return {role:spec.role,content};});
}
function classificationMessages(items,reusePolicy){return [{role:'system',content:[
 '你负责《最终幻想VII 重制版》日文原声的整句保留审查，不翻译、不改字幕、不猜切点。这里只能看到文本和声学测量，不能声称听到了音频。',
 reusePolicy,
 '只将明确可直接用于中文配音的非语言发声（喘息、笑哭、呻吟、兼容的啊哦嗯类）归onomatopoeia。任何实际词句都归speech；不确定或ASR为空归unknown，禁止因无字幕、短句、无识别结果或响度低猜拟声。',
 '每条只做整句分类；混合正文+拟声仍是speech。speech_text_jp/zh/en分别从本条text_jp/zh/en只删除真正非语言拟声，返回保留的实际正文原字；不得改写、增字或改用译文。这三份任一有正文就不能纯拟声。',
 'はい（是/好的）、いいえ（不是/不）、いい（好/可以）、おい（喂，明确招呼）均承载日语词义，必须归speech并保留其正文；不能因很短、全假名或感叹语气误判为拟声。',
 'ASR来自Japanese定向Qwen3。referential_translations仅辅助理解词义，不能用它替代原文。原文よし/よっしゃ/しまった/ねえ等承载日语词义，不能仅因感叹或很短归拟声。',
 '原始官方JP字幕缺失事实独立保留。ASR为空只能unknown，即使其他字幕像拟声也不能据此确认纯拟声；PCM全零由本地程序另行验证，不由你认定拟声。',
 '返回完整JSON对象且仅decisions数组。每条且仅有stem、kind(speech/onomatopoeia/unknown)、speech_text_jp、speech_text_zh、speech_text_en、directly_reusable(boolean)、reason(简短可复用证据)；每个输入stem恰好一次。',
 ].join('\n')},{role:'user',content:JSON.stringify(items)}];}
function createPipeline({sql,config,clients,store,rows,glossary,glossaryProvider,reusePolicy,analyze,log=()=>{}}){
 const byStem=new Map(rows.map((x,i)=>[x.stem,i]));
 async function checkpoint(job,stage,inputHash,fn){const old=job.checkpoints?.[stage];if(old?.input_hash===inputHash)return old;const value=await fn();job.checkpoints[stage]=value;return value;}
 async function translate(job,lang){
  const line=await store.line(job.stem),src='text_'+lang,dst='translate_zh_'+lang;
  const nameReview=lang==='jp'&&job.checkpoints?.name_review_jp?.state==='pending'?job.checkpoints.name_review_jp:null;
  if(nonempty(line[dst])&&!nameReview)return;
  if(nameReview&&(line[dst]!==nameReview.expected_old_text||hash(line[src]??'')!==nameReview.source_hash)){await store.event(job.stem,'name_review_jp',nameReview.source_hash,{...nameReview,state:'cancelled_source_or_translation_change'});return;}
  const source=line[src]??'',inputHash=hash(source);
  if(!source.trim()&&!(lang==='jp'&&job.checkpoints.asr?.state==='empty'))return;
  const perform=async()=>{
   const index=byStem.get(job.stem);if(index!==undefined)rows[index]={...rows[index],text_jp:line.text_jp,text_en:line.text_en,dialogue_evidence:line.dialogue_evidence};
   const context=index===undefined?{before:[],after:[]}:contextFor(rows,index,lang);
   const currentGlossary=glossaryProvider?glossaryProvider():glossary;
   const names=currentNames(line.text_jp,line.text_en,currentGlossary);
   const specs=[{role:'system',key:'translation.independent.system'},{role:'user',key:'translation.independent.input',values:{sourceLanguage:lang==='jp'?'日文':'英文',current:source,...context}}];
   if(names.length)specs.push({role:'user',key:'translation.name-glossary',values:{name_glossary:nameGlossaryText(names,source,lang)}});
   const messages=await latestMessages(sql,specs);
   if(!source.trim())messages.push({role:'user',content:'当前日文ASR正常返回空字符串，没有可译正文。不要补写或猜词，只输出严格JSON：{"translation":""}。'});
   const maxTokens=Math.min(8192,Math.max(512,Math.ceil((128+3*[...source].length)/128)*128)*2**Math.min(job.attempts??0,3));
   let output;
   try{output=await clients.chat({messages,task:'independent-translation-'+lang,stem:job.stem,promptKeys:specs.map(x=>x.key),maxTokens});}
   catch(error){
    if(error.message==='llm-truncated'&&(maxTokens===8192||(job.attempts??0)>=3))return store.event(job.stem,'translate_'+lang,inputHash,{state:'needs_review_output_limit',max_tokens:maxTokens,source_text:source,error:'llm-truncated-max-budget'});
    throw error;
   }
   const translated=parseIndependentTranslation(output.content,source);validateNames(translated.text,source,lang,names);
   return store.saveTranslation(job,line,lang,translated,inputHash,{...output,name_reference_revision:currentGlossary.revision},nameReview);
  };
  if(nameReview)job.checkpoints['translate_'+lang]=await perform();
  else await checkpoint(job,'translate_'+lang,inputHash,perform);
 }
 async function processLine(job){
  job.checkpoints??={};let line=await store.line(job.stem);if(!line)throw Error('line-deleted');
  const missingJp=line.extra?.audio_extraction?.missing_jp===true;
  if(job.origin.original_japanese_subtitle_missing&&!missingJp){
   const file=safeJpPath(config.dataRoot,job.stem),bytes=await fsp.readFile(file),sha=hash(bytes);
   await checkpoint(job,'asr',sha,async()=>{
    const result=await clients.asr(job.stem,file);
    if(hash(await fsp.readFile(file))!==sha)throw Error('source-changed-during-asr');
    return store.saveAsr(job,line,result,sha);
   });
  }
  await translate(job,'jp');
  await translate(job,'en');
  // ASR immediately flows into translation; CPU acoustic evidence is needed only for final reuse review.
  if(job.checkpoints.asr){
   const file=safeJpPath(config.dataRoot,job.stem),sha=hash(await fsp.readFile(file));
   await checkpoint(job,'acoustic',sha,async()=>{
    let evidence;try{evidence={...await analyze(file),state:'measured'};}catch(error){evidence={state:'decode_failed',decoded:false,error:String(error.code??'acoustic-decode-error')};}
    return store.event(job.stem,'acoustic',sha,evidence);
   });
  }
  // Only missing-original-JP lines need ASR-based classification; official text translations end here.
  if(job.origin.original_japanese_subtitle_missing&&missingJp&&line.extra?.audio_extraction?.jp_source_absent===true){await store.event(job.stem,'source_exception',hash(line.extra?.audio_extraction),{state:'confirmed_no_independent_jp_source_for_row',scope:'this_catalog_row_only_not_whole_performance',evidence:line.extra?.jp_source_absence??line.extra?.audio_extraction?.jp_source_absence??null});await store.complete(job,null);return;}
  if(job.origin.original_japanese_subtitle_missing&&missingJp&&line.extra?.audio_extraction?.jp_pairing_unresolved===true){const result=await store.finishUnresolvedPairing(job,line,config.dataRoot);if(result.completed){log('paired-japanese-already-processed',{stem:job.stem});return;}}
  if(job.origin.original_japanese_subtitle_missing&&missingJp){await store.waitSource(job);log('waiting-jp-source',{stem:job.stem});return;}
  if(job.checkpoints.asr)await store.complete(job,'classify');else await store.complete(job,null);
  log('preprocessed',{stem:job.stem,asr:job.checkpoints.asr?.state??'not-required'});
 }
 async function sourceEvidence(job){
  const asr=job.checkpoints?.asr,acoustic=job.checkpoints?.acoustic;
  let sha;try{sha=hash(await fsp.readFile(safeJpPath(config.dataRoot,job.stem)));}catch{return {valid:false,reason:'source-file-unavailable',expected_asr_sha256:asr?.source_sha256??null,expected_acoustic_sha256:acoustic?.source_sha256??acoustic?.input_hash??null};}
  const expected=acoustic?.source_sha256??acoustic?.input_hash;
  return {valid:sha===asr?.source_sha256&&sha===expected,current_sha256:sha,expected_asr_sha256:asr?.source_sha256??null,expected_acoustic_sha256:expected??null,reason:'source-sha-check'};
 }
 async function classifyBatch(jobs){
  const items=[],verifiedJobs=[];
  for(const job of jobs){const check=await sourceEvidence(job);if(!check.valid){await store.sourceChanged(job,check);continue;}const line=await store.line(job.stem),asr=job.checkpoints.asr;if(!line||!asr)throw Error('classification-source-missing');verifiedJobs.push(job);items.push({stem:job.stem,text_jp:asr.text,text_zh:line.text_zh??'',text_en:line.text_en??'',original_japanese_subtitle_missing:job.origin.original_japanese_subtitle_missing,asr_state:asr.state,acoustic:job.checkpoints.acoustic,referential_translations:{from_japanese:line.translate_zh_jp,from_english:line.translate_zh_en}});}
  if(!verifiedJobs.length)return;
  const pending=items.filter(item=>jobs.find(job=>job.stem===item.stem)?.checkpoints.classification?.input_hash!==hash(item));
  const output=pending.length?await clients.chat({messages:classificationMessages(pending,reusePolicy),task:'remake-asr-vocalization-review',stem:null,maxTokens:Math.min(8192,Math.max(512*pending.length,Math.ceil(JSON.stringify(pending).length*2/128)*128))}):null;
  const decisions=output?parseDecisions(output.content,pending):[];
  for(const job of verifiedJobs){
   const check=await sourceEvidence(job);if(!check.valid){await store.sourceChanged(job,check);continue;}
   const item=items.find(x=>x.stem===job.stem),decision=decisions.find(x=>x.stem===job.stem)??job.checkpoints.classification.decision,line=await store.line(job.stem),asr=job.checkpoints.asr,acoustic=job.checkpoints.acoustic;
   const decisionHash=hash(item),saved=job.checkpoints.classification?.input_hash===decisionHash?job.checkpoints.classification:await store.event(job.stem,'classification',decisionHash,{state:'reviewed',decision,log_id:String(output.logId),model:output.model,input:item});
   const route=lockDecision({line,asr,acoustic,decision});
   // Human/source edits after ASR, and translated official text changes, always take priority.
   if(line.text_jp!==asr.text||(line.text_zh??'')!==item.text_zh||(line.text_en??'')!==item.text_en){route.allow=false;route.reason='text-changed-after-asr';}
   let locked=false;
   if(route.allow){const bytes=await fsp.readFile(safeJpPath(config.dataRoot,job.stem));if(hash(bytes)!==asr.source_sha256||acoustic.source_sha256!==asr.source_sha256){await store.sourceChanged(job,{reason:'source-changed-before-lock-copy',current_sha256:hash(bytes),expected_asr_sha256:asr.source_sha256,expected_acoustic_sha256:acoustic.source_sha256});continue;}
    const result=await store.lockOriginal(job,line,bytes,asr.source_sha256,route,{classification_event:saved.event_id,acoustic_event:acoustic.event_id,asr_event:asr.event_id},config.dataRoot);
    if(result.state==='kept_changed_source_audio'){await store.sourceChanged(job,{reason:'source-changed-in-lock-transaction',expected_asr_sha256:asr.source_sha256});continue;}
    locked=result.state==='locked';
    if(result.state!=='locked')await store.event(job.stem,'lock',asr.source_sha256,result);
   }else await store.event(job.stem,'lock',asr.source_sha256,{state:'not_locked',reason:route.reason});
   await store.complete(job,null);log('reviewed',{stem:job.stem,lock:locked,reason:route.reason});
  }
 }
 return {processLine,classifyBatch,translate};
}
async function main(args=process.argv.slice(2)){
 const opts=options(args),config=loadConfig(),requireCommon=Module.createRequire(path.join(common,'package.json')),postgres=requireCommon('postgres');
 const sql=postgres(config.databaseUrl,{max:10,onnotice(){}});let guard;
 const log=(event,details={})=>console.log(JSON.stringify({at:new Date().toISOString(),event,...details}));
 try{
  const [identity]=await sql`SELECT current_database() AS database,current_user AS role`;
  if(identity.database!=='studio_ff7_remake'||identity.role!=='ff7remake')throw Error('actual-remake-database-mismatch');
  if(opts.status){console.log(JSON.stringify(await sql`SELECT phase,status,count(*)::int AS count FROM remake_preprocess_jobs GROUP BY phase,status ORDER BY phase,status`));return;}
  await fsp.mkdir(config.stateDir,{recursive:true});const stopFile=path.join(config.stateDir,'STOP');if(fs.existsSync(stopFile)){log('paused');return;}
  guard=await sql.reserve();const [lock]=await guard`SELECT pg_try_advisory_lock(7707,20261104) AS acquired`;if(!lock.acquired){log('already-running');return;}
  let scope=null;if(config.scopeFile){scope=JSON.parse(await fsp.readFile(config.scopeFile,'utf8'));if(!Array.isArray(scope)||!scope.length||scope.some(x=>typeof x!=='string'||!/^[\w.-]+$/.test(x)))throw Error('invalid-scope');}
  const store=createStore(sql);await store.initialize(scope);if(opts.prepare){log('prepared');return;}
  if(!config.asrUrl||!config.llmUrl||!config.llmModel)throw Error('explicit-preprocess-model-endpoints-required');
  const clients=createClients({config,sql}),rows=await sql`SELECT l.stem,l.text_jp,l.text_en,m.dialogue_mode,m.dialogue_evidence,m.extra FROM lines l LEFT JOIN line_meta m USING(stem) ORDER BY l.id`;
  const contextRows=rows.map(contextualize);
  const glossary=compileNames(loadNames(config.stateDir));
  // Import a pure shared policy constant without any production-env loader or model routing.
  const ts=requireCommon('typescript'),m=new Module(__filename);m._compile(ts.transpileModule(fs.readFileSync(path.join(common,'src/lib/onomatopoeia-reuse-policy.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,__filename);const reusePolicy=m.exports.ORIGINAL_VOICE_REUSE_POLICY;
  const analyze=async file=>{const result=await execFileAsync('python3',[path.join(project,'worker/preprocess_acoustics.py'),file],{timeout:150000,maxBuffer:1024*1024});return JSON.parse(result.stdout);};
  const pipeline=createPipeline({sql,config,clients,store,rows:contextRows,glossary,glossaryProvider:()=>compileNames(loadNames(config.stateDir)),reusePolicy,analyze,log});
  let stopping=false;const stop=()=>{stopping=true;};process.on('SIGTERM',stop);process.on('SIGINT',stop);
  const stopped=()=>stopping||fs.existsSync(stopFile);let count=0;
  log('started',{lineWorkers:4,asrConcurrency:4,llmConcurrency:4,thinking:false,model:config.llmModel,phase:opts.phase,limit:Number.isFinite(opts.limit)?opts.limit:null});
  async function preprocessWorker(){while(!stopped()&&count<opts.limit){count++;const [job]=await store.claim('preprocess',scope);if(!job)return;try{await pipeline.processLine(job);}catch(e){await store.retry(job,e);log('retry',{stem:job.stem,phase:'preprocess',error:String(e.code??e.message).slice(0,100)});}}}
  let reviewed=0;
  async function classifyWorker(){while(!stopped()&&reviewed<opts.limit){
   const n=Math.min(8,opts.limit-reviewed);reviewed+=n;const jobs=await store.claim('classify',scope,n);if(!jobs.length)return;
   // A failed batch retries as single items, avoiding one malformed/long result blocking its peers forever.
   const groups=jobs.some(job=>job.attempts>=2)?jobs.map(job=>[job]):[jobs];
   for(const group of groups){try{await pipeline.classifyBatch(group);}catch(e){
    for(const job of group){const [current]=await sql`SELECT status FROM remake_preprocess_jobs WHERE stem=${job.stem}`;if(current?.status!=='classifying')continue;
     if(group.length===1&&job.attempts>=4&&['llm-truncated','classification-count-mismatch','classification-fields','classification-body-not-deletion','classification-invalid','classification-stem-mismatch','invalid-json-fields'].includes(e.message)){
      await store.event(job.stem,'classification',null,{state:'needs_manual_review',error:e.message,retry_budget_exhausted:true});
      await store.event(job.stem,'lock',null,{state:'not_locked',reason:'classification-unresolved'});await store.complete(job,null);
     }else await store.retry(job,e);
    }
    log('retry',{phase:'classify',error:String(e.code??e.message).slice(0,100)});
   }}
  }}
  do{
   if(opts.phase!=='classify')await Promise.all([0,1,2,3].map(preprocessWorker));
   if(!stopped()&&opts.phase!=='preprocess')await Promise.all([0,1,2,3].map(classifyWorker));
   if(opts.once||Number.isFinite(opts.limit)||stopped())break;
   const [pending]=await sql`SELECT count(*)::int AS count FROM remake_preprocess_jobs WHERE status NOT IN('done','needs_review') AND (${scope===null} OR stem=ANY(${scope??[]}::text[]))`;
   if(!pending.count)break;count=0;reviewed=0;await sleep(5000);
  }while(!stopped());
  log('stopped',{status:await sql`SELECT phase,status,count(*)::int AS count FROM remake_preprocess_jobs GROUP BY phase,status`});
 }finally{if(guard){await guard`SELECT pg_advisory_unlock(7707,20261104)`;guard.release();}await sql.end({timeout:5});}
}
module.exports={loadConfig,options,latestMessages,classificationMessages,createPipeline,main};
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({event:'fatal',error:String(e.code??e.message??'preprocess-error').replace(/[^\w.:-]/g,'-').slice(0,120)}));process.exitCode=1;});
