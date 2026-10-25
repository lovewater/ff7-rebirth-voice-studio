#!/usr/bin/env node
// 中文注释约定：这是独立资料翻译，不是TTS改稿。只写translate_zh_jp/en，绝不改text_zh和锁定。
const fs=require('node:fs'),path=require('node:path');
const {base,load}=require('./translation/load-production.cjs');
const {parseTranslation}=require('./translation/output-policy.cjs');
const {loadNames,compileNames,currentEnglishNames,promptNames,validateNames}=require('./translation/names.cjs');
const {sql}=load(base+'/src/lib/db.ts');
const {callChatCompletion}=load(base+'/src/lib/llm-chat-client.ts');
const {resolvePromptMessages}=load(base+'/src/lib/prompt-store.ts');
const {samePerformance}=load(base+'/src/lib/rewrite-prompt.ts');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const stateDir=path.resolve(process.env.TRANSLATION_STATE_DIR||base+'/data/translation-background');
fs.mkdirSync(stateDir,{recursive:true});
const stopFile=path.join(stateDir,'STOP');
let stopping=false,claimed=0,guardConnection;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
const log=(event,data={})=>console.log(JSON.stringify({at:new Date().toISOString(),event,...data}));
const sourceColumn=lang=>lang==='jp'?'text_jp':'text_en';
const targetColumn=lang=>lang==='jp'?'translate_zh_jp':'translate_zh_en';
const scopeFile=process.env.TRANSLATION_SCOPE_FILE;
const scopeStems=scopeFile?JSON.parse(fs.readFileSync(scopeFile,'utf8')):null;
if(scopeFile&&(!Array.isArray(scopeStems)||!scopeStems.length||scopeStems.some(s=>typeof s!=='string'||!s.trim())))throw Error('翻译范围必须是非空stem数组');
const priorityStem=process.env.TRANSLATION_PRIORITY_STEM||'';
const translationModel='minimax-m3';

/** 固定使用数据库证据识别同演出，沿列表稳定id顺序，在边界停下。
 * 每个方向只取同语言非空的最多两条，遇到不同演出不得越界。
 * 无可证明演出归属时宁可不传上下文；输入中没有中文、另一种源语言或人物中文名。
 */
function contextFor(rows,index,lang){
 const line=rows[index],col=sourceColumn(lang),before=[],after=[];
 if(line.dialogue_mode!=='scene')return {before,after};
 for(const [direction,out] of [[-1,before],[1,after]]){
  for(let i=index+direction;i>=0&&i<rows.length&&out.length<2;i+=direction){
   const r=rows[i];
   if(r.dialogue_mode!=='scene'||!samePerformance(line.dialogue_evidence,r.dialogue_evidence))break;
   if(r[col]?.trim())out.push({text:r[col]});
  }
 }
 before.reverse();return {before,after};
}

async function seed(){
 // 仅填缺失译文，不覆盖已有译文；范围内每种语言独立排队。
 for(const lang of ['jp','en']){
  const src=sql(sourceColumn(lang)),dst=sql(targetColumn(lang));
  await sql`INSERT INTO line_translation_jobs(stem,source_language,source_hash,status)
   SELECT stem,${lang},md5(${src}),'pending' FROM lines
   WHERE nullif(btrim(${src}),'') IS NOT NULL AND nullif(btrim(${dst}),'') IS NULL
    AND (${scopeStems===null} OR stem=ANY(${scopeStems||[]}::text[]))
   ON CONFLICT(stem,source_language) DO UPDATE SET source_hash=excluded.source_hash,status='pending',attempts=0,
    next_attempt_at=now(),claimed_at=NULL,completed_at=NULL,error=NULL,name_review_target=NULL,name_review_priority=0,updated_at=now()
   WHERE line_translation_jobs.source_hash<>excluded.source_hash OR line_translation_jobs.status='done'`;
 }
 await sql`UPDATE line_translation_jobs SET status='retry',next_attempt_at=now(),claimed_at=NULL,error='worker-restarted',updated_at=now()
  WHERE status='running' AND (${scopeStems===null} OR stem=ANY(${scopeStems||[]}::text[]))`;
 await sql`UPDATE line_translation_jobs SET next_attempt_at=now() WHERE status='retry' AND (${scopeStems===null} OR stem=ANY(${scopeStems||[]}::text[]))`;
}
async function status(){return await sql`SELECT source_language,status,count(*)::int AS count FROM line_translation_jobs WHERE (${scopeStems===null} OR stem=ANY(${scopeStems||[]}::text[])) GROUP BY source_language,status ORDER BY source_language,status`;}
async function main(){
 if(process.argv.includes('--status')){console.log(JSON.stringify(await status()));return;}
 if(fs.existsSync(stopFile)){log('paused');return;}
 // 数据库会话锁额外保护手动直接启动/不同状态目录，防止误回收另一活进程的running。
 guardConnection=await sql.reserve();
 const [guard]=await guardConnection`SELECT pg_try_advisory_lock(7707,20261019) AS acquired`;
 if(!guard.acquired){log('already-running');return;}
 if(!process.env.VOLCENGINE_LLM_URL||!process.env.VOLCENGINE_LLM_KEY)throw Error('未配置MiniMax连接，禁止回退离线模型');
 await seed();
 if(process.argv.includes('--prepare')){log('prepared',{status:await status()});return;}
 // 同时只保留一套只读官方源文。各任务重新核对hash；长任务不把译文作为下一条上下文。
 const rows=await sql`SELECT l.stem,l.text_jp,l.text_en,m.dialogue_mode,m.dialogue_evidence FROM lines l LEFT JOIN line_meta m USING(stem) ORDER BY l.id`;
 const byStem=new Map(rows.map((r,i)=>[r.stem,i]));
 const glossary=compileNames(loadNames(stateDir));
 const limitArg=process.argv.find(x=>x.startsWith('--limit=')),limit=limitArg?Number(limitArg.slice(8)):Infinity;
 log('started',{concurrency:3,sourceRows:rows.length,model:translationModel,thinking:false,maxOutputTokens:512,scope:scopeStems?.length??'all-missing'});
 async function worker(slot){
  while(!stopping&&!fs.existsSync(stopFile)&&claimed<limit){
   // 逐条事务领取，三个worker不会领取同一个任务。done立即落库就是断点。
   const job=await sql.begin(async tx=>{
    const [j]=await tx`SELECT j.* FROM line_translation_jobs j JOIN lines l USING(stem)
     WHERE j.status IN ('pending','retry') AND j.next_attempt_at<=now()
      AND (${scopeStems===null} OR j.stem=ANY(${scopeStems||[]}::text[]))
      AND ((j.source_language='jp' AND nullif(btrim(l.text_jp),'') IS NOT NULL AND nullif(btrim(l.translate_zh_jp),'') IS NULL)
       OR (j.source_language='en' AND nullif(btrim(l.text_en),'') IS NOT NULL AND nullif(btrim(l.translate_zh_en),'') IS NULL))
     ORDER BY (j.stem=${priorityStem}) DESC,j.name_review_priority DESC,l.id,j.source_language LIMIT 1 FOR UPDATE OF j SKIP LOCKED`;
    if(!j)return null;
    await tx`UPDATE line_translation_jobs SET status='running',attempts=attempts+1,claimed_at=now(),updated_at=now() WHERE stem=${j.stem} AND source_language=${j.source_language}`;return j;
   });
   if(!job){
    const [n]=await sql`SELECT count(*)::int AS count FROM line_translation_jobs j JOIN lines l USING(stem) WHERE j.status<>'done'
      AND (${scopeStems===null} OR j.stem=ANY(${scopeStems||[]}::text[]))
      AND ((j.source_language='jp' AND nullif(btrim(l.text_jp),'') IS NOT NULL AND nullif(btrim(l.translate_zh_jp),'') IS NULL)
       OR (j.source_language='en' AND nullif(btrim(l.text_en),'') IS NOT NULL AND nullif(btrim(l.translate_zh_en),'') IS NULL))`;
    if(!n.count)return;await sleep(5000);continue;
   }
   claimed++;const started=Date.now();log('claim',{slot,stem:job.stem,lang:job.source_language});
   try{
    const i=byStem.get(job.stem),line=rows[i],lang=job.source_language,col=sourceColumn(lang),dst=sql(targetColumn(lang));
    if(!line||!line[col]?.trim())throw Error('源字幕已消失，需要刷新任务快照');
    const context=contextFor(rows,i,lang);
    // 只从本句英文选术语，日译中/英译中共享本句命中表，但不传另一语言的整句。
    if(job.name_review_target&&job.name_review_target!==glossary.revision)throw Object.assign(Error('人名表版本不符'),{code:'name-glossary-revision-mismatch'});
    const names=currentEnglishNames(line.text_en,glossary);
    const nameMessages=names.length?[{role:'user',content:'',promptKey:'translation.name-glossary',promptValues:{name_glossary:JSON.stringify(promptNames(names))}}]:[];
    const messages=await resolvePromptMessages([
     {role:'system',content:'',promptKey:'translation.independent.system'},
     {role:'user',content:'',promptKey:'translation.independent.input',promptValues:{sourceLanguage:lang==='jp'?'日文':'英文',current:line[col],...context}},
     ...nameMessages
    ]);
    const output=await callChatCompletion({messages,modelId:'volcengine',task:'independent-translation-'+lang,
     stem:job.stem,promptKeys:['translation.independent.system','translation.independent.input',...(names.length?['translation.name-glossary']:[])],
     json:true,maxTokens:512,attempts:3,volcengine:{model:translationModel,thinking:'disabled',reasoningEffort:'none'}});
    // MiniMax返回值仍严格校验；字段不合规进入原有checkpoint退避重试。
    const translated=parseTranslation(output.content,line[col]);
    validateNames(translated,line[col],lang,names);
    const written=await sql.begin(async tx=>{
     const [saved]=await tx`UPDATE lines SET ${dst}=${translated.trim()} WHERE stem=${job.stem} AND md5(${sql(col)})=${job.source_hash} AND nullif(btrim(${dst}),'') IS NULL RETURNING stem`;
     if(!saved){await tx`UPDATE line_translation_jobs SET status='retry',next_attempt_at=now()+interval '1 hour',error='source-changed-restart-required',updated_at=now() WHERE stem=${job.stem} AND source_language=${lang}`;return false;}
     await tx`UPDATE line_translation_jobs SET status='done',completed_at=now(),updated_at=now(),error=NULL,model=${translationModel},name_reference_revision=${glossary.revision} WHERE stem=${job.stem} AND source_language=${lang}`;return true;
    });
    log(written?'done':'source-changed',{slot,stem:job.stem,lang,elapsedMs:Date.now()-started});
   }catch(error){
    // 只保存清理后的错误类型，不向任务日志写HTTP头、原始URL或密钥。访问详情在正式访问日志表中。
    const code=error?.code||error?.name||'translation-error';
    const delaySeconds=Math.min(21600,60*2**Math.min(Number(job.attempts),8));
    await sql`UPDATE line_translation_jobs SET status='retry',next_attempt_at=now()+${delaySeconds}*interval '1 second',updated_at=now(),error=${String(code)} WHERE stem=${job.stem} AND source_language=${job.source_language}`;
    log('retry',{slot,stem:job.stem,lang:job.source_language,error:String(code),delaySeconds});
   }
  }
 }
 await Promise.all([0,1,2].map(worker));log('stopped',{status:await status()});
}
module.exports={contextFor};
if(require.main===module)main().catch(e=>{log('fatal',{error:e?.code||e?.name||'error'});process.exitCode=1;}).finally(async()=>{if(guardConnection){await guardConnection`SELECT pg_advisory_unlock(7707,20261019)`;guardConnection.release();}await sql.end({timeout:5});});
