#!/usr/bin/env node
// Reschedule only existing name-validation retries. Do not run a worker or change any checkpoint.
const fs=require('node:fs/promises'),path=require('node:path'),Module=require('node:module'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const {loadConfig}=require('../preprocess-dialogue.cjs'),{hash}=require('./policy.cjs');
async function scheduleNameRetries(sql){return sql.begin(async tx=>{
 const rows=await tx`SELECT j.stem,j.next_attempt_at,j.attempts,to_jsonb(j) AS before,l.text_jp,l.text_en,l.translate_zh_jp,l.translate_zh_en,
 (SELECT max(id)::text FROM llm_access_logs WHERE stem=j.stem AND task IN('independent-translation-jp','independent-translation-en')) AS last_translation_log_id
 FROM remake_preprocess_jobs j JOIN lines l USING(stem) WHERE j.status='retry' AND j.error='translation-name-mismatch' ORDER BY l.id FOR UPDATE OF j SKIP LOCKED`;
 const changed=[];
 for(const row of rows){
  const [after]=await tx`UPDATE remake_preprocess_jobs j SET next_attempt_at=now() WHERE stem=${row.stem} AND status='retry' AND error='translation-name-mismatch' RETURNING next_attempt_at,to_jsonb(j) AS after`;
  if(!after)continue;
  const beforeFields={...row.before},afterFields={...after.after};delete beforeFields.next_attempt_at;delete afterFields.next_attempt_at;
  if(JSON.stringify(beforeFields)!==JSON.stringify(afterFields))throw Error('unexpected-non-timer-job-change');
  const audit={reason:'Reviewed Remake input #59 preserves leading names; glossary #60 maps verified English aliases. Advance existing retry only; unique running main worker will claim it.',prompt_versions:{input:59,name_glossary:60},previous_next_attempt_at:row.next_attempt_at,next_attempt_at:after.next_attempt_at,attempts_unchanged:row.attempts,checkpoints_unchanged:true,old_translations_unchanged:true,last_translation_log_id:row.last_translation_log_id};
  await tx`INSERT INTO remake_preprocess_events(stem,stage,input_hash,evidence) VALUES(${row.stem},'retry_schedule',${hash({jp:row.text_jp,en:row.text_en})},${tx.json(audit)})`;
  changed.push({stem:row.stem,...audit,original_translation_jp:row.translate_zh_jp,original_translation_en:row.translate_zh_en});
 }
 return changed;
});}
async function main(args=process.argv.slice(2)){
 const argument=args.find(x=>x.startsWith('--require-main-pid='));if(args.length!==1||!argument||!/^[0-9]+$/.test(argument.slice(19)))throw Error('explicit-current-main-pid-required');
 const requiredPid=Number(argument.slice(19)),config=loadConfig(),req=Module.createRequire(path.resolve(__dirname,'../../../studio-common/website/package.json')),sql=req('postgres')(config.databaseUrl,{max:2});
 try{
  const {stdout}=await promisify(execFile)('systemctl',['show','ff7-remake-preprocess-20261104.service','--property=MainPID','--value']);if(Number(stdout.trim())!==requiredPid||!requiredPid)throw Error('main-worker-pid-changed');
  const [identity]=await sql`SELECT current_database() database,current_user role`;if(identity.database!=='studio_ff7_remake'||identity.role!=='ff7remake')throw Error('remake-database-role-mismatch');
  const prompts=await sql`SELECT DISTINCT ON(key) key,id FROM prompt_templates WHERE key IN('translation.independent.input','translation.name-glossary') AND enable=true ORDER BY key,updated_at DESC,id DESC`;
  if(!prompts.some(x=>x.key==='translation.independent.input'&&Number(x.id)===59)||!prompts.some(x=>x.key==='translation.name-glossary'&&Number(x.id)===60))throw Error('reviewed-prompt-versions-not-current');
  const changed=await scheduleNameRetries(sql),report={at:new Date().toISOString(),main_worker_pid:requiredPid,changed};
  const file=path.join(config.stateDir,'validation','name-retry-schedule-'+Date.now()+'.json');await fs.writeFile(file,JSON.stringify(report,null,2));console.log(JSON.stringify({changed:changed.length,stems:changed.map(x=>x.stem),report:file}));
 }finally{await sql.end();}
}
module.exports={scheduleNameRetries,main};
if(require.main===module)main().catch(error=>{console.error(JSON.stringify({error:String(error.code??error.message).slice(0,120)}));process.exitCode=1;});
