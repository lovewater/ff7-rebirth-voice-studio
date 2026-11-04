#!/usr/bin/env node
// Remake-only one-time audit/repair preparation. Never clears a translation before its replacement passes.
const fs=require('node:fs/promises'),path=require('node:path'),Module=require('node:module');
const {loadConfig}=require('../preprocess-dialogue.cjs'),{createStore}=require('./store.cjs'),{hash,nonempty}=require('./policy.cjs');
const {loadNames,compileNames,currentJapaneseNames,validateNames,requiredNames}=require('./names.cjs');
function nameReviewEligibility(row,catalog,model){
 const names=currentJapaneseNames(row.text_jp,catalog);
 if(!names.length)return {eligible:false,reason:'no-direct-japanese-name'};
 const missing=names.filter(entry=>{try{validateNames(row.translate_zh_jp,row.text_jp,'jp',[entry]);return false;}catch{return true;}});
 if(!missing.length)return {eligible:false,reason:'already-correct'};
 const cp=row.checkpoints?.translate_jp;
 const result={eligible:false,missing_names:missing.map(({english,japanese,chinese})=>({english,japanese,chinese}))};
 if(cp?.state!=='translated'||!cp.log_id||cp.model!==model||row.llm_task!=='independent-translation-jp'||row.llm_model!==model||row.llm_status!=='success')return {...result,reason:'not-this-pipeline-machine-translation'};
 if(row.translate_zh_jp!==cp.text)return {...result,reason:'translation-edited'};
 if(cp.input_hash!==hash(row.text_jp??'')||cp.source_text!==row.text_jp)return {...result,reason:'source-changed'};
 if(row.origin?.manual_review_revision==null||String(row.manual_review_revision??0)!==String(row.origin.manual_review_revision)||row.has_marked_audio)return {...result,reason:'manual-selection-changed-or-present'};
 return {...result,eligible:true,reason:'missing-official-japanese-name'};
}
async function rows(sql,stem=null){return sql`SELECT l.stem,l.text_jp,l.text_en,l.translate_zh_jp,j.origin,j.checkpoints,j.status,COALESCE(rv.revision,0) AS manual_review_revision,
 EXISTS(SELECT 1 FROM line_tts_versions v WHERE v.stem=l.stem AND v.review_state IN('locked','abnormal')) AS has_marked_audio,
 log.task AS llm_task,log.response_model AS llm_model,log.status AS llm_status
 FROM lines l JOIN remake_preprocess_jobs j USING(stem) LEFT JOIN remake_review_revisions rv USING(stem)
 LEFT JOIN llm_access_logs log ON log.id=CASE WHEN j.checkpoints->'translate_jp'->>'log_id' ~ '^[0-9]+$' THEN (j.checkpoints->'translate_jp'->>'log_id')::bigint ELSE NULL END
 WHERE j.checkpoints?'translate_jp' AND NULLIF(btrim(l.translate_zh_jp),'') IS NOT NULL AND (${stem===null} OR l.stem=${stem}) ORDER BY l.id`;}
async function appendNamePrompt(sql){
 const [old]=await sql`SELECT * FROM prompt_templates WHERE key='translation.name-glossary' AND enable=true ORDER BY updated_at DESC,id DESC LIMIT 1`;
 if(!old||old.role!=='user')throw Error('name-prompt-not-configured');
 const prompt=[
 '以下官方人名对照只包含当前待译原文或本句可核对来源中命中的名字，不是整张词表。',
 'matched_in_current_source=true 表示当前待译原文确实出现该名字；翻译必须使用对照中的官方中文名，不能另音译、换字或省掉原文已有的人名。verified_japanese_aliases仅是已验证的同名写法。',
 'matched_in_current_source=false 只供辨认参考。当前待译原文没有该人名时，绝不能因为英文/日文的另一版本或上下文中有名字就补写、强塞该名字。日译中只翻当前日文，英译中只翻当前英文；两条译文独立，不借用另一版台词内容。',
 '日文姓名可以紧接助词或尊称（如クラウドは、クラウドさん），仍按实际出现的人名使用官方中文译名，尊称按语境自然处理。不要猜未知人名、未知别名或ASR错字。',
 '{{name_glossary}}',
 ].join('\n');
 const seed='remake-japanese-direct-name-glossary-v1-'+hash(prompt);
 const result=await sql`INSERT INTO prompt_templates(key,name,"desc",prompt,enable,role,category,placeholders,source_path,seed_hash)
 VALUES('translation.name-glossary',${old.name+' · 日文直接命中'},'Remake本句日/英直接命中；标明当前源文是否出现，禁止跨语言强塞人名',${prompt},true,'user',${old.category},${sql.json(old.placeholders)},'studio-ff7-remake/scripts/preprocess/name-review.cjs',${seed})
 ON CONFLICT(seed_hash) DO NOTHING RETURNING id`;
 return {previous_id:String(old.id),new_id:result[0]?String(result[0].id):null,seed_hash:seed};
}
async function main(args=process.argv.slice(2)){
 if(args.some(arg=>!['--apply','--update-prompt'].includes(arg)))throw Error('unknown-name-review-argument');
 const config=loadConfig(),req=Module.createRequire(path.resolve(__dirname,'../../../studio-common/website/package.json')),sql=req('postgres')(config.databaseUrl,{max:3,onnotice(){}});let guard;
 try{
  const [identity]=await sql`SELECT current_database() database,current_user role`;if(identity.database!=='studio_ff7_remake'||identity.role!=='ff7remake')throw Error('remake-database-role-mismatch');
  if(args.length){guard=await sql.reserve();const [lock]=await guard`SELECT pg_try_advisory_lock(7707,20261104) acquired`;if(!lock.acquired)throw Error('preprocess-worker-still-running');}
  const catalog=compileNames(loadNames(config.stateDir));
  if(!catalog.revision||!catalog.entries.length)throw Error('remake-name-glossary-required');
  const report={at:new Date().toISOString(),revision:catalog.revision,applied:args.includes('--apply'),counts:{},items:[],prompt:args.includes('--update-prompt')?await appendNamePrompt(sql):null};
  for(const row of await rows(sql)){
   const eligibility=nameReviewEligibility(row,catalog,config.llmModel);report.counts[eligibility.reason]=(report.counts[eligibility.reason]??0)+1;
   if(!eligibility.eligible){if(eligibility.missing_names?.length)report.items.push({stem:row.stem,...eligibility});continue;}
   let queued=false;
   if(args.includes('--apply'))queued=await sql.begin(async tx=>{
    await tx`SELECT stem FROM lines WHERE stem=${row.stem} FOR UPDATE`;await tx`SELECT stem FROM remake_preprocess_jobs WHERE stem=${row.stem} FOR UPDATE`;
    const [fresh]=await rows(tx,row.stem);if(!fresh||!nameReviewEligibility(fresh,catalog,config.llmModel).eligible)return false;
    if(fresh.checkpoints?.name_review_jp?.state==='pending'&&fresh.checkpoints.name_review_jp.glossary_revision===catalog.revision)return false;
    const store=createStore(tx),review={state:'pending',expected_old_text:fresh.translate_zh_jp,source_hash:hash(fresh.text_jp),glossary_revision:catalog.revision,manual_review_revision:String(fresh.manual_review_revision),missing_names:eligibility.missing_names,previous_checkpoint:fresh.checkpoints.translate_jp};
    await store.event(row.stem,'name_review_jp',review.source_hash,review,tx);
    await tx`UPDATE remake_preprocess_jobs SET status='pending',phase='preprocess',attempts=0,next_attempt_at=now(),claimed_at=NULL,completed_at=NULL,error='official-japanese-name-review',updated_at=now() WHERE stem=${row.stem}`;return true;
   });
   report.items.push({stem:row.stem,...eligibility,queued,old_translation:row.translate_zh_jp,source_text:row.text_jp});
  }
  report.queued=report.items.filter(x=>x.queued).length;
  await fs.mkdir(config.stateDir,{recursive:true});const file=path.join(config.stateDir,'japanese-name-review-'+Date.now()+'.json');await fs.writeFile(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({revision:report.revision,counts:report.counts,queued:report.queued,prompt:report.prompt,report:file}));
 }finally{if(guard){await guard`SELECT pg_advisory_unlock(7707,20261104)`;guard.release();}await sql.end({timeout:5});}
}
module.exports={nameReviewEligibility,appendNamePrompt,main};
if(require.main===module)main().catch(error=>{console.error(JSON.stringify({event:'name-review-failed',error:String(error.code??error.message).slice(0,100)}));process.exitCode=1;});
