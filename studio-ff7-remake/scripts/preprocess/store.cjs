const fs=require('node:fs/promises'),path=require('node:path');
const {hash,contextualize,pairingManifest,japaneseCandidateState,safeJpPath}=require('./policy.cjs');
function createStore(sql){
 async function line(stem,tx=sql){return contextualize((await tx`SELECT l.id,l.stem,l.speaker,l.text_jp,l.text_en,l.text_zh,l.translate_zh_jp,l.translate_zh_en,m.extra,m.dialogue_mode,m.dialogue_evidence,m.jp_start_s,m.jp_end_s,m.jp_dur_s,m.jp_speech_s FROM lines l LEFT JOIN line_meta m USING(stem) WHERE l.stem=${stem}`)[0]);}
 async function event(stem,stage,inputHash,evidence,tx=sql){
  const [e]=await tx`INSERT INTO remake_preprocess_events(stem,stage,input_hash,evidence) VALUES(${stem},${stage},${inputHash},${tx.json(evidence)}) RETURNING id`;
  const checkpoint={...evidence,input_hash:inputHash,event_id:String(e.id)};
  await tx`UPDATE remake_preprocess_jobs SET checkpoints=jsonb_set(checkpoints,ARRAY[${stage}],${tx.json(checkpoint)},true),updated_at=now() WHERE stem=${stem}`;
  // Merge only our namespace. Never overwrite extraction recovery, chapter or other agents' keys.
  await tx`UPDATE line_meta SET extra=jsonb_set(COALESCE(extra,'{}'::jsonb),'{remake_preprocess}',COALESCE(extra->'remake_preprocess','{}'::jsonb)||jsonb_build_object(${stage}::text,${tx.json({input_hash:inputHash,event_id:String(e.id),state:evidence.state??null,model:evidence.model??null,...(stage==='asr'?{original_japanese_subtitle_missing:true,original_text_jp:evidence.original_text_jp,text_jp_filled:evidence.text_jp_filled}:{}),completed_at:new Date().toISOString()})}),true) WHERE stem=${stem}`;
  return checkpoint;
 }
 async function initialize(scope){
  await sql.unsafe(await fs.readFile(path.join(__dirname,'schema.sql'),'utf8'));
  await sql`INSERT INTO remake_preprocess_jobs(stem,origin)
   SELECT l.stem,jsonb_build_object('text_jp',l.text_jp,'text_en',l.text_en,'text_zh',l.text_zh,'original_japanese_subtitle_missing',NULLIF(btrim(l.text_jp),'') IS NULL,'created_at',now(),'manual_review_revision',COALESCE(rv.revision,0))
   FROM lines l LEFT JOIN remake_review_revisions rv USING(stem) WHERE (${scope===null} OR l.stem=ANY(${scope??[]}::text[])) ON CONFLICT(stem) DO NOTHING`;
  // A single process advisory lock is acquired before this recovery, so live workers cannot be stolen.
  await sql`UPDATE remake_preprocess_jobs SET status=CASE WHEN phase='classify' THEN 'review_pending' ELSE 'pending' END,claimed_at=NULL,updated_at=now(),error='worker-restarted' WHERE status IN('running','classifying') AND (${scope===null} OR stem=ANY(${scope??[]}::text[]))`;
 }
 async function claim(phase,scope,count=1){return sql.begin(async tx=>{
  const rows=await tx`SELECT j.* FROM remake_preprocess_jobs j JOIN lines l USING(stem) WHERE j.phase=${phase}
   AND (j.status=${phase==='classify'?'review_pending':'pending'} OR j.status='retry') AND j.next_attempt_at<=now()
   AND (${scope===null} OR j.stem=ANY(${scope??[]}::text[])) ORDER BY l.id LIMIT ${count} FOR UPDATE OF j SKIP LOCKED`;
  if(rows.length)await tx`UPDATE remake_preprocess_jobs SET status=${phase==='classify'?'classifying':'running'},attempts=attempts+1,claimed_at=now(),updated_at=now() WHERE stem=ANY(${rows.map(x=>x.stem)})`;
  return rows;
 });}
 async function retry(job,error){const delay=Math.min(21600,30*2**Math.min(job.attempts??0,9));const code=String(error?.code??error?.message??'preprocess-error').replace(/[^\w.:-]/g,'-').slice(0,100);await sql`UPDATE remake_preprocess_jobs SET status='retry',error=${code},next_attempt_at=now()+${delay}*interval '1 second',updated_at=now() WHERE stem=${job.stem}`;}
 async function waitSource(job){await sql`UPDATE remake_preprocess_jobs SET status='retry',phase='preprocess',error='jp-source-await-recovery',next_attempt_at=now()+interval '60 seconds',claimed_at=NULL,updated_at=now() WHERE stem=${job.stem}`;}
 async function complete(job,phase){await sql`UPDATE remake_preprocess_jobs SET status=${phase==='classify'?'review_pending':'done'},phase=${phase??'classify'},completed_at=${phase?null:new Date().toISOString()},claimed_at=NULL,error=NULL,next_attempt_at=now(),updated_at=now() WHERE stem=${job.stem}`;}
 async function saveAsr(job,snapshot,result,sourceSha){return sql.begin(async tx=>{
  const current=await line(job.stem,tx);
  const [saved]=await tx`UPDATE lines SET text_jp=${result.text} WHERE stem=${job.stem} AND text_jp IS NOT DISTINCT FROM ${snapshot.text_jp} AND NULLIF(btrim(text_jp),'') IS NULL RETURNING stem`;
  const evidence={...result,source_sha256:sourceSha,original_japanese_subtitle_missing:true,original_text_jp:job.origin.text_jp,original_text_en:job.origin.text_en,text_jp_filled:!!saved,kept_manual_text:!saved&&current?.text_jp!==result.text};
  return event(job.stem,'asr',sourceSha,evidence,tx);
 });}
 async function saveTranslation(job,snapshot,lang,translation,inputHash,output,nameReview=null){return sql.begin(async tx=>{
  const col='text_'+lang,dst='translate_zh_'+lang;
  if(nameReview){
   await tx`SELECT stem FROM lines WHERE stem=${job.stem} FOR UPDATE`;
   const current=await line(job.stem,tx),[revision]=await tx`SELECT revision FROM remake_review_revisions WHERE stem=${job.stem}`;
   const marked=await tx`SELECT id FROM line_tts_versions WHERE stem=${job.stem} AND review_state IN('locked','abnormal') LIMIT 1`;
   if(current?.[col]!==snapshot[col]||current?.[dst]!==nameReview.expected_old_text||String(revision?.revision??0)!==String(nameReview.manual_review_revision)||marked.length){
    await event(job.stem,'name_review_jp',inputHash,{...nameReview,state:'cancelled_manual_or_source_change',unused_model_output:translation.text,unused_log_id:String(output.logId)},tx);
    return job.checkpoints.translate_jp;
   }
  }
  const [saved]=await tx`UPDATE lines SET ${tx(dst)}=${translation.text||null} WHERE stem=${job.stem} AND ${tx(col)} IS NOT DISTINCT FROM ${snapshot[col]} AND ((${nameReview===null} AND NULLIF(btrim(${tx(dst)}),'') IS NULL) OR (${nameReview!==null} AND ${tx(dst)} IS NOT DISTINCT FROM ${nameReview?.expected_old_text??null})) RETURNING stem`;
  if(!saved){const current=await line(job.stem,tx);if(current?.[col]!==snapshot[col])throw Error('source-changed-during-translation');return event(job.stem,'translate_'+lang,inputHash,{state:'kept_existing_translation',text:current?.[dst]??null},tx);}
  const savedCheckpoint=await event(job.stem,'translate_'+lang,inputHash,{...translation,log_id:String(output.logId),model:output.model,source_text:snapshot[col]??'',name_reference_revision:output.name_reference_revision??null},tx);
  if(nameReview)await event(job.stem,'name_review_jp',inputHash,{...nameReview,state:'done',old_translation:nameReview.expected_old_text,new_translation:translation.text,new_log_id:String(output.logId),new_translation_event:savedCheckpoint.event_id},tx);
  return savedCheckpoint;
 });}
 async function finishUnresolvedPairing(job,snapshot,dataRoot){
  const manifest=pairingManifest(snapshot.extra);
  if(!manifest||manifest.stems.includes(job.stem))return {completed:false,reason:'unresolved-pairing-proof-incomplete'};
  const candidates=await sql`SELECT l.stem,l.text_jp,l.translate_zh_jp,m.extra,j.origin,j.checkpoints FROM lines l LEFT JOIN line_meta m USING(stem) LEFT JOIN remake_preprocess_jobs j USING(stem) WHERE l.stem=ANY(${manifest.stems})`;
  if(candidates.length!==manifest.stems.length)return {completed:false,reason:'candidate-row-missing'};
  const evidence=[];
  for(const clip of manifest.candidates){
   let sha;try{sha=hash(await fs.readFile(safeJpPath(dataRoot,clip.stem)));}catch{return {completed:false,reason:'candidate-file-missing'};}
   if(sha!==clip.mp3_sha256)return {completed:false,reason:'candidate-source-sha-mismatch'};
   const state=japaneseCandidateState(candidates.find(row=>row.stem===clip.stem),sha);
   if(!state.ready)return {completed:false,reason:state.reason};
   evidence.push({stem:clip.stem,audio_path:clip.audio_path,...state});
  }
  return sql.begin(async tx=>{
   await tx`SELECT stem FROM lines WHERE stem=${job.stem} FOR UPDATE`;
   const [meta]=await tx`SELECT extra FROM line_meta WHERE stem=${job.stem} FOR UPDATE`;
   const current=await line(job.stem,tx),now=pairingManifest(meta?.extra);
   if(!current||current.extra?.audio_extraction?.missing_jp!==true||!now||now.input_hash!==manifest.input_hash||current.text_jp!==snapshot.text_jp||current.text_en!==snapshot.text_en)return {completed:false,reason:'pairing-source-changed'};
   // Hold candidate source/translation rows while committing the cross-row provenance checkpoint.
   await tx`SELECT stem FROM lines WHERE stem=ANY(${manifest.stems}) ORDER BY stem FOR SHARE`;
   await tx`SELECT stem FROM line_meta WHERE stem=ANY(${manifest.stems}) ORDER BY stem FOR SHARE`;
   const fresh=await tx`SELECT l.stem,l.text_jp,l.translate_zh_jp,m.extra,j.origin,j.checkpoints FROM lines l LEFT JOIN line_meta m USING(stem) LEFT JOIN remake_preprocess_jobs j USING(stem) WHERE l.stem=ANY(${manifest.stems})`;
   for(const expected of evidence){const state=japaneseCandidateState(fresh.find(row=>row.stem===expected.stem),expected.source_sha256);if(!state.ready||state.source_text_hash!==expected.source_text_hash||state.translation_hash!==expected.translation_hash)return {completed:false,reason:'candidate-state-changed'};}
   await event(job.stem,'source_exception',manifest.input_hash,{state:'jp-already-processed-in-other-rows-pairing-unresolved',scope:'this_english_row_only_no_subclip_pairing_claimed',evidence:manifest.value,candidates:evidence,japanese_audio_created:false,japanese_asr_requested_for_this_row:false},tx);
   await tx`UPDATE remake_preprocess_jobs SET status='done',phase='classify',completed_at=now(),claimed_at=NULL,error=NULL,updated_at=now() WHERE stem=${job.stem}`;
   return {completed:true,state:'jp-already-processed-in-other-rows-pairing-unresolved'};
  });
 }
 async function sourceChanged(job,evidence){return sql.begin(async tx=>{
  await event(job.stem,'source_exception',evidence.current_sha256??null,{state:'source_changed_requires_review',...evidence,existing_text_and_translation_preserved:true,asr_and_classification_not_reused:true},tx);
  await tx`UPDATE remake_preprocess_jobs SET status='needs_review',phase='classify',completed_at=now(),claimed_at=NULL,error='source_changed_requires_review',updated_at=now() WHERE stem=${job.stem}`;
 });}
 async function lockOriginal(job,snapshot,bytes,sourceSha,route,evidence,dataRoot){
  // Serialize with website manual selection on the same line row; no existing mark is cleared.
  return sql.begin(async tx=>{
   await tx`SELECT stem FROM lines WHERE stem=${job.stem} FOR UPDATE`;
   const current=await line(job.stem,tx);
   if(!current||current.text_jp!==snapshot.text_jp||current.text_en!==snapshot.text_en||current.text_zh!==snapshot.text_zh||hash(current.extra?.audio_extraction??{})!==hash(snapshot.extra?.audio_extraction??{}))return {state:'kept_changed_source'};
   const [revision]=await tx`SELECT revision FROM remake_review_revisions WHERE stem=${job.stem}`;
   if(String(revision?.revision??0)!==String(job.origin?.manual_review_revision??0))return {state:'kept_manual_review_change'};
   const marked=await tx`SELECT id FROM line_tts_versions WHERE stem=${job.stem} AND review_state IN('locked','abnormal') LIMIT 1 FOR UPDATE`;
   if(marked.length)return {state:'kept_manual_selection',version_id:String(marked[0].id)};
   if(hash(await fs.readFile(path.join(dataRoot,'jp',job.stem+'.mp3')))!==sourceSha)return {state:'kept_changed_source_audio'};
   const label=current.text_zh?.trim()||current.text_jp?.trim()||'（日文原声）';
   const [version]=await tx`INSERT INTO line_tts_versions(stem,speaker,voice_version_id,voice_gpu_key,tts_text,spoken_text,subtitle_text,jp_text_snapshot,game_zh_text_snapshot,duration_factor,emo_alpha) VALUES(${job.stem},${current.speaker},NULL,'jp-lock',${label},${label},NULL,${current.text_jp},${current.text_zh},1,0) RETURNING id`;
   const relative=`tts/${job.stem}/${version.id}.mp3`,target=path.join(dataRoot,relative);
   await fs.mkdir(path.dirname(target),{recursive:true});
   // Exclusive filename, no transcoding. Re-read source SHA is checked by caller immediately before transaction.
   await fs.writeFile(target,bytes,{flag:'wx'});
   if(hash(await fs.readFile(target))!==sourceSha)throw Error('jp-copy-sha-mismatch');
   await tx`UPDATE line_tts_versions SET status='ready',audio_path=${relative},audio_bytes=${bytes.length},start_s=${current.jp_start_s},end_s=${current.jp_end_s},dur_s=${current.jp_dur_s},speech_s=${current.jp_speech_s},conversion_meta=${tx.json({pipeline:'jp-lock',workflow:route.workflow,source:`jp/${job.stem}.mp3`,source_sha256:sourceSha,reason:route.reason,preprocess_evidence:evidence,skip_tts:true,subtitle_unchanged:true})},review_state='locked',used_at=now(),completed_at=now(),error=NULL WHERE id=${version.id}`;
   return event(job.stem,'lock',sourceSha,{state:'locked',version_id:String(version.id),source_sha256:sourceSha,route},tx);
  });
  // On any transaction/COMMIT error, keep the exclusively created file for later audit.
  // A fresh connection seeing no row cannot prove rollback: the original COMMIT may still succeed.
 }
 return {line,event,initialize,claim,retry,waitSource,complete,saveAsr,saveTranslation,finishUnresolvedPairing,sourceChanged,lockOriginal};
}
module.exports={createStore};
