#!/usr/bin/env node
// Read-only PG/files audit. No clients, inference, queue mutation or review writes.
const fs=require('node:fs/promises'),path=require('node:path'),Module=require('node:module');
const {loadConfig}=require('../preprocess-dialogue.cjs'),policy=require('./policy.cjs');
const {hash,body,lockDecision,safeJpPath}=policy;
const project=path.resolve(__dirname,'../..'),common=path.resolve(project,'../studio-common/website');
const requireCommon=Module.createRequire(path.join(common,'package.json'));
const canonical=value=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])):value);
function sourcePath(root,relative){const p=path.resolve(root,relative);if(!p.startsWith(path.resolve(root)+path.sep))throw Error('audio-path-outside-project');return p;}
async function main(){
 const config=loadConfig(),sql=requireCommon('postgres')(config.databaseUrl,{max:2,onnotice(){}}),now=new Date().toISOString(),out=path.join(project,'work/preprocess-lock-audit');await fs.mkdir(out,{recursive:true});
 let snapshot;
 try{
  snapshot=await sql.begin('read only isolation level repeatable read',async tx=>{
   const [identity]=await tx`SELECT current_database() database,current_user role,transaction_timestamp() snapshot_at`;if(identity.database!=='studio_ff7_remake'||identity.role!=='ff7remake')throw Error('wrong-database');
   const locks=await tx`SELECT v.id::text,v.stem,v.speaker,v.status,v.review_state,v.audio_path,v.audio_bytes,v.subtitle_text,v.jp_text_snapshot,v.game_zh_text_snapshot,v.conversion_meta,v.created_at,l.text_jp,l.text_en,l.text_zh,m.extra,j.origin,j.checkpoints,COALESCE(rv.revision,0)::text review_revision FROM line_tts_versions v JOIN lines l USING(stem) JOIN line_meta m USING(stem) LEFT JOIN remake_preprocess_jobs j USING(stem) LEFT JOIN remake_review_revisions rv USING(stem) WHERE v.voice_gpu_key='jp-lock' AND v.review_state='locked' AND v.conversion_meta->>'workflow' IN('remake-preprocess-pure-vocalization-original','remake-preprocess-silent-original') ORDER BY v.id`;
   const ids=[...new Set(locks.flatMap(v=>Object.values(v.conversion_meta?.preprocess_evidence??{})).map(String))];
   const events=ids.length?await tx`SELECT id::text,stem,stage,input_hash,evidence,created_at FROM remake_preprocess_events WHERE id=ANY(${ids}::bigint[])`:[];
   const logIds=[...new Set(events.filter(x=>x.stage==='classification').map(x=>x.evidence?.log_id).filter(Boolean).map(String))];
   const logs=logIds.length?await tx`SELECT id::text,status,requested_model,response_model,request_body,response_body,reasoning_tokens,length(COALESCE(reasoning_text,''))::int reasoning_text_length FROM llm_access_logs WHERE id=ANY(${logIds}::bigint[])`:[];
   const actorPlan=JSON.parse(await fs.readFile(path.join(project,'work/speaker-recovery/plan.json'),'utf8'));
   const actorStems=actorPlan.proposals.map(x=>x.stem);
   const actors=await tx`SELECT l.stem,l.speaker,l.text_jp,l.text_en,l.text_zh,l.translate_zh_jp,l.translate_zh_en,m.extra,j.status,j.phase,j.origin,j.checkpoints,COALESCE(rv.revision,0)::text review_revision,EXISTS(SELECT 1 FROM line_tts_versions v WHERE v.stem=l.stem AND v.review_state IN('locked','abnormal')) has_marked_audio FROM lines l JOIN line_meta m USING(stem) LEFT JOIN remake_preprocess_jobs j USING(stem) LEFT JOIN remake_review_revisions rv USING(stem) WHERE l.stem=ANY(${actorStems}) ORDER BY l.id`;
   return {snapshot_at:identity.snapshot_at,locks,events,logs,actors};
  });
  const events=new Map(snapshot.events.map(x=>[x.id,x])),logs=new Map(snapshot.logs.map(x=>[x.id,x]));const problems=[],observations=[],checked=[],lexicalExamples=new Map(),seenStems=new Set(),modelCounts={},workflowCounts={};
  for(const v of snapshot.locks){
   const errors=[],meta=v.conversion_meta??{},refs=meta.preprocess_evidence??{},asr=events.get(String(refs.asr_event)),acoustic=events.get(String(refs.acoustic_event)),classification=events.get(String(refs.classification_event));
   if(v.status!=='ready')errors.push('locked-version-not-ready');
   if(!v.speaker)errors.push('version-speaker-missing');
   if(meta.pipeline!=='jp-lock'||meta.skip_tts!==true||meta.subtitle_unchanged!==true)errors.push('original-copy-flags-missing');
   if(meta.source!==`jp/${v.stem}.mp3`)errors.push('source-path-mismatch');
   const extracted=v.extra?.audio_sources?.jp?.clip;
   if(!extracted?.mp3_sha256||extracted.mp3_sha256!==meta.source_sha256||extracted.audio_path!==meta.source)errors.push('extraction-manifest-source-sha-or-path-mismatch');
   workflowCounts[meta.workflow]=(workflowCounts[meta.workflow]??0)+1;
   if(seenStems.has(v.stem))errors.push('multiple-locked-auto-originals');seenStems.add(v.stem);
   let sourceSha,targetSha,sourceBytes,targetBytes;
   try{[sourceBytes,targetBytes]=await Promise.all([fs.readFile(safeJpPath(config.dataRoot,v.stem)),fs.readFile(sourcePath(config.dataRoot,v.audio_path))]);sourceSha=hash(sourceBytes);targetSha=hash(targetBytes);if(sourceSha!==targetSha||sourceSha!==meta.source_sha256)errors.push('source-target-record-sha-mismatch');if(Number(v.audio_bytes)!==targetBytes.length)errors.push('record-audio-bytes-mismatch');}catch{errors.push('source-or-target-file-unreadable');}
   for(const [name,event] of [['asr',asr],['acoustic',acoustic],['classification',classification]])if(!event||event.stem!==v.stem||event.stage!==name)errors.push('missing-or-wrong-'+name+'-event');
   if(asr&&acoustic&&classification){
    const a=asr.evidence,k=acoustic.evidence,c=classification.evidence,d=c.decision,log=logs.get(String(c.log_id));
    if(a.language!=='Japanese'||!['recognized','empty'].includes(a.state))errors.push('invalid-japanese-asr-evidence');
    if(asr.input_hash!==meta.source_sha256||a.source_sha256!==meta.source_sha256||acoustic.input_hash!==meta.source_sha256||k.source_sha256!==meta.source_sha256)errors.push('evidence-source-sha-mismatch');
    if(!k.decoded||!k.full_clip||k.frames<=0||k.channels>2)errors.push('invalid-full-acoustic-evidence');
    if(!v.origin?.original_japanese_subtitle_missing)errors.push('not-missing-original-japanese-subtitle');
    if(v.extra?.audio_extraction?.preview_only===true||v.extra?.audio_extraction?.missing_jp===true||v.extra?.audio_extraction?.channels>2||v.extra?.audio_extraction?.eligible_for_generation===false)errors.push('preview-or-missing-source-locked');
    if(v.jp_text_snapshot!==a.text)errors.push('locked-japanese-snapshot-not-asr-text');
    if(c.input?.stem!==v.stem||c.input?.text_jp!==a.text||c.input?.asr_state!==a.state||c.input?.acoustic?.source_sha256!==meta.source_sha256)errors.push('classification-input-chain-mismatch');
    if(d?.stem!==v.stem)errors.push('classification-decision-stem-mismatch');
    const line={speaker:v.speaker,extra:v.extra},route=lockDecision({line,asr:a,acoustic:k,decision:d});
    if(!route.allow)errors.push('current-independent-lock-policy-rejects:'+route.reason);
    if(meta.workflow==='remake-preprocess-pure-vocalization-original'){
     if(a.state!=='recognized'||!a.text?.trim())errors.push('empty-or-failed-asr-pure-vocalization-lock');
     if(d?.kind!=='onomatopoeia'||d.directly_reusable!==true||['jp','zh','en'].some(l=>body(d?.['speech_text_'+l])))errors.push('classification-contains-speech-or-not-reusable');
    }else if(k.exact_zero!==true)errors.push('silent-workflow-without-exact-pcm-zero');
    modelCounts[log?.response_model??'missing']=(modelCounts[log?.response_model??'missing']??0)+1;
    if(!log||log.status!=='success'||log.requested_model!==config.llmModel||log.requested_model!==log.response_model||log.requested_model!==c.model||log.request_body?.chat_template_kwargs?.enable_thinking!==false||Number(log.reasoning_tokens??0)!==0||log.reasoning_text_length!==0)errors.push('model-no-think-log-chain-invalid');
    else{let raw;try{raw=JSON.parse(log.response_body.choices[0].message.content).decisions.find(x=>x.stem===v.stem);}catch{}if(!raw||canonical(raw)!==canonical(d))errors.push('recorded-decision-not-in-model-response');}
    lexicalExamples.set(a.text,(lexicalExamples.get(a.text)??0)+1);
   }
   if(v.subtitle_text!==null)observations.push({id:v.id,stem:v.stem,type:'subtitle-currently-overridden-after-auto-copy',review_revision:v.review_revision});
   if(errors.length)problems.push({id:v.id,stem:v.stem,asr_text:asr?.evidence?.text,errors});
   checked.push({id:v.id,stem:v.stem,source_sha256:sourceSha,target_sha256:targetSha,record_sha256:meta.source_sha256,extraction_sha256:extracted?.mp3_sha256,proof_event_ids:refs,problem_count:errors.length});
  }
  const actorStates={},actorOutcomes={},actorCandidates=[],unsafeActorCandidates=[];
  for(const row of snapshot.actors){actorStates[row.status??'no-job']=(actorStates[row.status??'no-job']??0)+1;const cp=row.checkpoints??{};const outcome=[row.status??'no-job',cp.lock?.state??'no-lock-state',cp.lock?.reason??'no-reason',cp.classification?.decision?.kind??'no-classification',row.has_marked_audio?'marked':'unmarked'].join('/');actorOutcomes[outcome]=(actorOutcomes[outcome]??0)+1;if(row.status!=='done'||cp.lock?.reason!=='speaker-missing'||row.has_marked_audio)continue;
   const blockers=[],a=cp.asr,k=cp.acoustic,d=cp.classification?.decision;if(!a||!k||!d)blockers.push('missing-stage-checkpoint');
   const route=lockDecision({line:row,asr:a,acoustic:k,decision:d});if(!route.allow)blockers.push(route.reason);
   let sha;try{sha=hash(await fs.readFile(safeJpPath(config.dataRoot,row.stem)));if(sha!==a?.source_sha256||sha!==k?.source_sha256)blockers.push('source-sha-changed');}catch{blockers.push('source-file-missing');}
   if(row.text_jp!==a?.text)blockers.push('japanese-source-text-changed');
   const input=cp.classification?.input;if(!input||input.text_zh!==(row.text_zh??'')||input.text_en!==(row.text_en??'')||input.text_jp!==a?.text)blockers.push('classification-source-fields-changed');
   if(String(row.review_revision)!==String(row.origin?.manual_review_revision??0))blockers.push('manual-review-revision-changed');
   const currentItem={stem:row.stem,text_jp:a?.text,text_zh:row.text_zh??'',text_en:row.text_en??'',original_japanese_subtitle_missing:row.origin?.original_japanese_subtitle_missing,asr_state:a?.state,acoustic:k,referential_translations:{from_japanese:row.translate_zh_jp,from_english:row.translate_zh_en}};
   if(!cp.classification||hash(currentItem)!==cp.classification.input_hash)blockers.push('classification-input-hash-would-trigger-new-model-call');
   const record={stem:row.stem,speaker:row.speaker,source_sha256:sha,classification_event:cp.classification?.event_id,classification_input_hash:cp.classification?.input_hash,asr_event:a?.event_id,acoustic_event:k?.event_id,manual_review_revision:row.review_revision,blockers};(blockers.length?unsafeActorCandidates:actorCandidates).push(record);
  }
  const [latest]=await sql`SELECT count(*)::int count,max(id)::text max_id FROM line_tts_versions WHERE voice_gpu_key='jp-lock' AND review_state='locked' AND conversion_meta->>'workflow' IN('remake-preprocess-pure-vocalization-original','remake-preprocess-silent-original')`;
  const summary={snapshot_at:snapshot.snapshot_at,audited_auto_locked_versions:checked.length,latest_auto_locked_count:latest.count,latest_max_id:latest.max_id,new_locks_since_snapshot:latest.count-checked.length,problems:problems.length,post_lock_subtitle_observations:observations.length,source_target_record_sha_all_equal:checked.every(x=>x.source_sha256===x.target_sha256&&x.source_sha256===x.record_sha256),extraction_manifest_sha_all_equal:checked.every(x=>x.source_sha256===x.extraction_sha256),model_counts:modelCounts,workflow_counts:workflowCounts,actor_recovery_job_statuses:actorStates,actor_recovery_outcomes:actorOutcomes,recovered_speaker_done_missing_unlocked:actorCandidates.length+unsafeActorCandidates.length,safe_checkpoint_only_requeue_candidates:actorCandidates.length,unsafe_or_nonvocal_candidates:unsafeActorCandidates.length,inference_calls:0,queue_mutations:0,business_row_writes:0};
  const report={summary,problems,observations,checked,locked_asr_text_counts:[...lexicalExamples].sort((a,b)=>b[1]-a[1]),safe_requeue_candidates:actorCandidates,excluded_requeue_candidates:unsafeActorCandidates};
  const file=path.join(out,'audit-'+now.replace(/[:.]/g,'-')+'.json');await fs.writeFile(file,JSON.stringify(report,null,2)+'\n');await fs.writeFile(path.join(out,'latest.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...summary,report:file}));
 }finally{await sql.end({timeout:5});}
}
main().catch(e=>{console.error(String(e.code??e.message));process.exitCode=1;});
