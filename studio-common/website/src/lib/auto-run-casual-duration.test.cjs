/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),crypto=require('node:crypto');
function compile(name,dependencies={},suffix='') {
 const m=new Module(__filename);
 m.require=id=>id==='./asr-word-corrections'?require('./asr-word-corrections.ts'):id==='./spoken-text-review'?require('./spoken-text-review.ts'):id==='./auto-run-stage-context'?require('./auto-run-stage-context.ts'):Object.hasOwn(dependencies,id)?dependencies[id]:id.startsWith('./')?{}:require(id);
 m.require=((resolve)=>id=>id==='./line-processing-state'?require('./line-processing-state.ts'):resolve(id))(m.require);m._compile(ts.transpileModule(fs.readFileSync(path.join(__dirname,name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText+suffix,path.join(__dirname,name+'.ts'));
 return m.exports;
}
const context=compile('llm-model-context'),workflow=compile('casual-duration-workflow'),speechPlan=compile('casual-speech-compression',{'./casual-duration-workflow':workflow}).planCasualSpeechCompression;
const modelPolicy=compile('auto-run-model-policy',{'./llm-model-context':context});
const budget=compile('auto-run-tts-budget');
const subtitles=compile('auto-run-subtitle');
function harness(options={}) {
 const line={processing_state:options.processingState??'active',stem:'TEST',speaker:Object.hasOwn(options,'speaker')?options.speaker:'cloud',text_zh:options.originalText??'完整的中文原稿',text_jp:options.textJp??'原文',text_en:options.textEn??'Original',translate_zh_jp:options.translateZhJp??null,translate_zh_en:options.translateZhEn??null,dialogue_mode:Object.hasOwn(options,'mode')?options.mode:'field',extra:options.extra,subtitle_italic:!!options.italic};
 if(options.productionScript){line.productionScript=options.productionScript;line.text_zh=options.productionScript.translation;}
 const clips=new Map(),files=new Map(),calls={tts:[],asr:[],actualBodyApi:[],jpAsr:[],cleanupPlans:[],assemblies:[],rewrites:[],events:[],edits:[],queries:[],transactions:[],referenceFiles:[],referenceRecords:[],judges:[],grouping:[],budgetFallback:0,normalizations:[],alignments:[],native:[],semanticRequests:[],imports:[]};
 let activeTransaction=null;
 let marked=!!options.markedAtStart,finished,serial=0;
 const audio=duration=>Buffer.from(String(Math.round(duration*1000)));
 files.set('jp/TEST.mp3',audio(options.target??9));
 if(options.cnSource)files.set('cn/TEST.mp3',options.cnSource);
 for(const raw of options.existingCandidates??[]) {const c={stem:'TEST',status:'ready',review_state:'candidate',voice_gpu_key:'zeroshot-jp',tts_text:line.text_zh,spoken_text:line.text_zh,subtitle_text:null,game_zh_text_snapshot:line.text_zh,auto_run_id:'old',audio_path:`tts/TEST/${raw.id}.wav`,conversion_meta:{tts_text_sent:line.text_zh},...raw};clips.set(c.id,c);files.set(c.audio_path,audio(raw.duration??8));serial=Math.max(serial,Number(c.id));}

 const seconds=b=>b===options.cnSource?8:Number(b.toString())/1000;
 const decode=b=>{const samples=new Float32Array(Math.round(seconds(b)*1000));
  if(samples.length && !(b===files.get('jp/TEST.mp3')&&options.jpAllZero) && !(b===options.cnSource&&options.cnSilent))samples[0]=options.jpSample??.1;
  return {sampleRate:1000,samples};};
 const key=p=>p.slice(p.indexOf('/data/')+6); // normalise workspace data root below
 const fileKey=p=>p.startsWith(process.cwd()+'/data/')?p.slice((process.cwd()+'/data/').length):key(p);
 const sql=async(parts,...values)=>{
  const q=parts.join('?');calls.queries.push(q);if(activeTransaction)activeTransaction.push(q);
  if(q.includes('SELECT l.stem, COALESCE'))return [{...line,text_zh:line.productionScript?line.productionScript.originalChinese:line.text_zh,translate_zh_jp:line.productionScript?.translation??line.translate_zh_jp,translate_zh_en:line.translate_zh_en,subtitle_text:line.text_zh}];
  if(q.includes('SELECT l.stem,'))return [line];
  if(q.includes('FROM asr_word_corrections'))return options.rulesChangedAtCommit?[]:options.asrWordRules??[];
  if(q.includes('FROM pronunciations'))return q.includes("usage='tts_pinyin'")?options.pinyinRules??[]:options.rules??[];
  if(q.includes("review_state IN ('locked','abnormal')")&&q.includes('SELECT id')) {
   if(options.markAtCommit&&q.includes('FOR UPDATE'))marked=true;
   return marked?[{id:'manual'}]:[];
  }
  if(q.includes('SELECT stem,text_zh,text_jp')||q.includes('SELECT text_zh,text_jp,text_en,translate_zh_jp'))return [{...line,
   text_zh:options.modelSourceChangedAtCommit&&activeTransaction?'人工新中文':Object.hasOwn(options,'currentOriginal')?options.currentOriginal:line.productionScript?line.productionScript.originalChinese:line.text_zh,
   translate_zh_jp:options.referenceChangedAtCommit&&activeTransaction?'人工新译文':options.currentTranslation??line.productionScript?.translation??line.translate_zh_jp,translate_zh_en:line.translate_zh_en}];
  if(q.includes('SELECT stem,text_zh FROM lines'))return [{stem:line.stem,text_zh:options.currentOriginal??line.text_zh}];
  if(q.includes('SELECT stem FROM lines'))return [{stem:line.stem}];
  if(q.includes('SELECT stem FROM line_auto_runs'))return [{stem:line.stem}];
  if(q.includes('SELECT id FROM line_auto_runs'))return [{id:'run'}];
  if(q.includes('INSERT INTO line_auto_run_events')){calls.events.push(values);return [];}
  if(/UPDATE line_auto_runs SET status\s*=/.test(q)){finished=values;return [];}
  if(q.includes('UPDATE line_auto_runs SET updated_at'))return [];
  if(q.includes('UPDATE line_auto_runs SET reference_audio_path')){calls.referenceRecords.push({promptPath:values[0],textJp:values[1]});return [{id:'run'}];}
  if(q.includes('SELECT id::text,stem,tts_text')) {
   if(q.includes('WHERE stem='))return [...clips.values()].filter(c=>c.auto_run_id==='old');
   const c=clips.get(values[0]);if(c&&options.mutateReuseSource)files.set(c.audio_path,audio(2.5));return c?[c]:[];
  }
  if(q.includes('SELECT id::text AS id, tts_text'))return values[1].map(id=>clips.get(String(id)));
  if(q.includes('SELECT id::text,tts_text,spoken_text,dur_s,audio_path'))return [clips.get(values[0])].filter(Boolean);
  if(q.includes('SELECT id::text,tts_text,dur_s'))return [...clips.values()];
  if(q.includes('SELECT v.id::text, v.review_state'))return [{...clips.get(values[0]),original_subtitle:line.text_zh}];
  if(q.includes('INSERT INTO line_tts_versions')&&values.includes('jp-lock')) {
   const id=String(++serial),clip={id,auto_run_id:values[1],voice_gpu_key:'jp-lock',tts_text:values[4],spoken_text:values[5],subtitle_text:values[6],jp_text_snapshot:values[7],game_zh_text_snapshot:values[8],review_state:'candidate'};
   clips.set(id,clip);return [clip];
  }
  if(q.includes('INSERT INTO line_tts_versions')&&q.includes("'cn-original'")) {
   assert.ok(q.includes('NULL,text_jp,text_zh'));
   const id=String(++serial),clip={id,auto_run_id:values[0],voice_gpu_key:'cn-original',tts_text:line.text_zh,spoken_text:line.text_zh,
    jp_text_snapshot:line.text_jp,game_zh_text_snapshot:line.text_zh,subtitle_text:null,review_state:'candidate',conversion_meta:values[1]};
   clips.set(id,clip);return [clip];
  }
  if(q.includes('INSERT INTO line_tts_versions')&&q.includes("speaker,'audio-edit',tts_text,spoken_text,NULL")) {
   const source=clips.get(values[2]),id=String(++serial),c={...source,id,auto_run_id:values[0],voice_gpu_key:'audio-edit',subtitle_text:null,conversion_meta:values[1]};clips.set(id,c);calls.imports.push({sourceId:source.id,id,metadata:values[1]});return [c];
  }
  if(q.includes('INSERT INTO line_tts_versions')) {
   const source=clips.get(values[1]),id=String(++serial),clip={...source,id,subtitle_text:source.subtitle_text,edited:true,conversion_meta:{...source.conversion_meta,...values[0]}};
   calls.edits.push(values[0]);clips.set(id,clip);return [clip];
  }
  if(q.includes("SET status='ready',audio_path=")) {
   const [audio_path,,start,end,dur_s,speech,id]=values;
   Object.assign(clips.get(id),{audio_path,dur_s,start,end,speech});
   if(options.markAfterCnSave&&clips.get(id).voice_gpu_key==='cn-original')marked=true;
   return [];
  }
  if(q.includes("UPDATE line_tts_versions v SET status = 'ready'")) {
   Object.assign(clips.get(values[3]),{audio_path:values[0],dur_s:options.target??9,conversion_meta:values[2]});return [];
  }
  if(q.includes("SET review_state='locked',used_at=now()")) {Object.assign(clips.get(values[0]),{review_state:'locked',used_at:'now'});return [];}
  if(q.includes('SET tts_text=')) {Object.assign(clips.get(values[3]),{tts_text:values[0],spoken_text:values[1],subtitle_text:values[2]});if(options.markAfterAssemblySave)marked=true;return [];}
  if(q.includes('SELECT subtitle_text')){const c=clips.get(values[0]);if(c&&options.finalSubtitle)c.subtitle_text=options.finalSubtitle;if(c&&options.finalSubtitleAtCommit&&q.includes('FOR UPDATE')&&q.includes('audio_path,spoken_text'))c.subtitle_text=options.finalSubtitleAtCommit;if(c&&options.manualSubtitleAtSave&&q.includes('FOR UPDATE'))c.subtitle_text='保存窗口人工改的字幕';if(c&&options.replaceBodyAtAssemblyCommit&&q.includes('FOR UPDATE')&&q.includes('audio_path')&&!q.includes('spoken_text'))files.set(c.audio_path,audio(6.375));return [c].filter(Boolean);}
  if(q.includes('SET subtitle_text=')) {Object.assign(clips.get(values[3]),{subtitle_text:values[0],review_state:values[1],used_at:values[2]?'now':null});return [];}
  if(/parent_tts_id\s*=\s*CASE/.test(q)) {
   if(q.includes('parent_tts_id = CASE'))return [];
   calls.grouping.push(q);assert.ok(q.includes("(review_state='candidate' OR id="));
   for(const c of clips.values())if(c.auto_run_id!=='old'&&(c.review_state==='candidate'||c.id===values[8])) {
    c.parent_tts_id=c.id===values[0]?null:values[0];c.llm_tokens=c.id===values[0]?values[3]:null;c.llm_speed=c.id===values[0]?values[5]:null;
   }
   return [];
  }
  if(q.includes('SET conversion_meta=')){const c=clips.get(values[1]);if(c&&values[0]&&typeof values[0]==='object')c.conversion_meta={...c.conversion_meta,...values[0]};return [];}
  throw Error('Unexpected SQL '+q);
 };
 sql.json=x=>x;sql.begin=async fn=>{const previous=activeTransaction,trace=[];calls.transactions.push(trace);activeTransaction=trace;try{return await fn(sql)}finally{activeTransaction=previous}};
 const api=compile('auto-run',{
  './auto-run-settings':{getAutoRunModel:async()=> 'grok',withAutoRunConnection:(_model,fn)=>fn()},
  './db':{sql},'./asr-word-corrections-db':{loadAsrWordRules:async()=>options.asrWordRules??[]},'./casual-duration-workflow':workflow,'./llm-model-context':context,
  './llm-metrics':{withLlmMetrics:(_r,_s,fn)=>fn(),llmMetricsForRun:async()=>options.metrics??({tokens:null,speed:null})},
  './auto-run-model-policy':modelPolicy,
  './pronounce':compile('pronounce'),'./tts-pronunciation':{applyTtsPronunciation:(text,rules)=>rules.reduce((s,r)=>s.split(r.word).join(r.replacement),text)},'./casual-original-reuse-policy':compile('casual-original-reuse-policy'),'./casual-semantic-review':compile('casual-semantic-review'),
  './model-chinese-script':compile('model-chinese-script'),
  './auto-run-tts-budget':{...budget,autoTtsBudgetFallback:async()=>{calls.budgetFallback++;throw Error('partial body cannot use outer fallback')}},
  './source-audio-policy':{audioReferenceIssue:()=>null,englishAudioRelativePath:()=>null},
  './pure-interjection':{pureInterjectionOriginal:()=>false},'./shushu-emotion':{pureShushuOriginal:()=>false},'./singing-original':{isSingingLine:()=>false},
  './auto-run-rules':{isPerformanceMode:mode=>mode==='scene'||mode==='mixed'},'./auto-run-two-parts':{withTwoPartContext:fn=>fn()},
  './audio-splice':{audioToMonoWav:async b=>{
   assert.notEqual(b,files.get('jp/TEST.mp3'),'ordinary JP must use seekable file decode');
   if(options.cnSource)assert.notEqual(b,options.cnSource,'original CN timing must use seekable file decode');
   return b;
  },audioFileToMonoWav:async p=>{
   const sourcePath=fileKey(p);assert.ok(['jp/TEST.mp3','cn/TEST.mp3'].includes(sourcePath));
   calls.referenceFiles.push(sourcePath);return files.get(sourcePath);
  }},
  './wav-stretch':{decodeWavMono:decode,stretchWav:(b,ratio)=>audio(Number(b.toString())/1000*ratio)},
  './tts-gpu':{normalizeScript:text=>({ttsText:text,spokenText:text}),wavTiming:b=>({start:0,end:seconds(b),duration:seconds(b),speech:seconds(b)})},
  './rubberband-core':{STRETCH_ALGORITHM:'rubberband-test'},
  './qwen-asr':{qwenAsr:async(b64,language,params)=>{
   if(language===undefined) {
    calls.actualBodyApi.push({b64});
    if(options.mutateDuringActualAsr)files.set('tts/TEST/1.wav',Buffer.from('after-network-file-change'));
    return {text:'实际转写',language:'Chinese',raw:{source:'actual-body-api'}};
   }
   calls.jpAsr.push({b64,language,params});assert.equal(language,'Japanese');
   if(options.markDuringJpAsr)marked=true;
   if(options.jpAsrError)throw Error('JP ASR unavailable');
   return {text:params?.useForcedAligner?line.text_jp:options.referenceAsrText??options.bodyTextJp??'日文正文',language:'Japanese',raw:{source:'real-api-shape'},alignment:{status:'ok',model:'Qwen/Qwen3-ForcedAligner-0.6B',time_unit:'seconds',items:[]}};
  }},
  './casual-speech-compression':{compressCasualSpeech:(input,target)=>{
   const frames=Math.round(seconds(input)*1000),fixed=Math.round((options.fixedExternalSeconds??0)*1000),leading=Math.floor(fixed/2),trailing=fixed-leading;
   const plan=speechPlan(frames,1000,{start:leading,end:frames-trailing},target);if(!plan)return null;
   return {audio:audio(plan.targetDuration),plan,metadata:{...plan,definition:'first-to-last-speech-span-including-internal-pauses',boundaryPolicy:'wavTiming-raw-peak',externalSilencePcmExact:true}};
  }},
  './casual-body-alignment':{alignCasualBodyToReference:(input,reference,target)=>{const before=seconds(input),removed=options.alignmentRemovedSeconds??0,output=removed?audio(Math.max(.02,before-removed)):input;const sha=b=>crypto.createHash('sha256').update(b).digest('hex');calls.alignments.push(input);calls.alignmentReferences??=[];calls.alignmentReferences.push({reference,target});return {audio:output,changed:!!removed,meta:{sourceSha256:sha(input),alignedSha256:sha(output),referenceSha256:sha(reference),beforeDuration:before,afterDuration:seconds(output),targetSeconds:target}};}},
  './casual-body-audio':{normalizeCasualBodyWav:async input=>{
   const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
   const changed=!!options.normalizeBody,duration=seconds(input),output=changed?audio(duration+(options.normalizedExtraSeconds??0)):input;
   const sourceFormat={format_tag:1,encoding:1,sample_rate:changed?22050:24000,channels:1,bits_per_sample:16,block_align:2,frames:duration*(changed?22050:24000),duration_s:duration};
   const normalizedFormat={...sourceFormat,sample_rate:24000,frames:seconds(output)*24000,duration_s:seconds(output)};
   calls.normalizations.push({input,output,changed});
   if(options.markDuringNormalization)marked=true;
   if(options.mutateDuringNormalization)for(const [key,value]of files)if(key.startsWith('tts/')&&value===input)files.set(key,audio(1.25));
   return {audio:output,changed,sourceSha256:sha(input),normalizedSha256:sha(output),sourceFormat,normalizedFormat};
  }},
  './casual-audio-cleanup':{
   planCasualAudioCleanup:input=>{
    calls.cleanupPlans.push(input);
    const enabled=!!options.cleanup && !(options.cleanupKind==='unclassified'&&!input.allowUnclassifiedEdges);
    const head=enabled?(options.head??1):0,tail=enabled?(options.tail??1):0,total=options.target??9;
    return {version:1,enabled,reason:enabled?'保守原声配对':'未确认独立可切片段',bodyTextZh:enabled?(options.bodyText??'完整的中文原稿'):line.text_zh,
     bodyTextJp:enabled?(options.bodyTextJp??'日文正文'):line.text_jp,bodyStartFrame:head*1000,bodyEndFrame:(total-tail)*1000,sourceFrames:total*1000,sampleRate:1000,
     preserved:enabled?[{side:'head',startFrame:0,endFrame:head*1000,kind:options.cleanupKind??'nonverbal'}]:[],
     removedChinesePrefix:enabled?(options.prefix??'嗯，'):'',removedChineseSuffix:enabled?(options.suffix??''):'',sourcePcmSha256:'source-sha',evidence:{}};
   },
   extractCasualBodyReference:(_input,plan)=>audio((plan.bodyEndFrame-plan.bodyStartFrame)/plan.sampleRate),
   casualCleanupTextMatches:(a,b)=>a===b&&!!a,
   assembleCasualOriginalEdges:(original,body,plan)=>{
    calls.assemblies.push({original,body,plan});if(options.assemblyFailure)throw Error('原声PCM拼回校验失败');
    const duration=seconds(body)+(plan.sourceFrames-(plan.bodyEndFrame-plan.bodyStartFrame))/plan.sampleRate;
    if(duration>(options.target??9)+.001)throw Error('正文超过可用时长');
    return {audio:audio(options.assemblyOverrun?duration+1:duration),metadata:{pcmExact:!options.badPcm,sourceFrames:plan.sourceFrames,outputFrames:duration*1000,sourcePcmSha256:plan.sourcePcmSha256,preserved:plan.preserved}};
   },
   restoreCasualScript:(plan,text)=>plan.removedChinesePrefix+text+plan.removedChineseSuffix,
  },
  './final-auto-subtitle':compile('final-auto-subtitle'),
  './auto-run-subtitle':subtitles,
  './rewrite-prompt':{takeUntilBoundary:()=>({before:[],after:[]})},
  './auto-run-llm':{
   judgeSpokenText:async input=>{calls.judges.push(input);assert.equal(context.currentChatModel(),'grok');return options.judgeResult??{ok:false,reason:'漏字'};},
   rewriteChat:async(messages,_temp,task)=>{assert.equal(context.currentChatModel(),'grok');const input=JSON.parse(messages[1].content);
    if(task==='casual-semantic-review') {calls.semanticRequests.push(input);const good={faithful:true,readingEquivalent:true,needsHuman:false,readingUncertain:false,hardReadingRisk:false,negationChanged:false,questionChanged:false,entityChanged:false,missingMeaning:[],addedMeaning:[],changedMeaning:[],reason:'独立语义与朗读均一致'};return {content:JSON.stringify(typeof options.semanticReview==='function'?options.semanticReview(input,calls.semanticRequests.length):options.semanticReview??good)};}
    calls.rewrites.push(input);return {content:JSON.stringify({text:typeof options.rewriteText==='function'?options.rewriteText(input,calls.rewrites.length):options.rewriteText??'完整中文'})};},
   parseJsonObject:JSON.parse,
  },
  'node:fs/promises':{stat:async p=>({size:options.missingFinal?0:files.get(fileKey(p))?.length??0}),mkdir:async()=>{},readFile:async p=>{const b=files.get(fileKey(p));if(!b)throw Error('missing audio '+p);return b;},writeFile:async(p,b)=>files.set(fileKey(p),b),rm:async p=>files.delete(fileKey(p))},
 },'\nexports.hooks={setClone:fn=>generateClone=fn,setAsr:fn=>asrQwen=fn,originalAsrQwen:asrQwen,generateClone,runCasual,casualJapaneseTextEvidence};');
 api.hooks.setClone(async(runId,stem,script,extra)=>{
  assert.equal(context.currentChatModel(),'grok');calls.tts.push({script,extra});
  if(options.budgetOnCall===calls.tts.length)throw new budget.AutoTtsBudgetError();
  if(options.noAudio)throw Error('TTS failed');
  return Array.from({length:options.partialBatch??extra.candidateCount??1},(_,index)=>{
   const id=String(++serial),audio_path=`tts/TEST/${id}.wav`;
   const dur_s=typeof options.duration==='function'?options.duration(calls.tts.length,index):options.duration??(calls.tts.length===1?10:8);
   const clip={id,tts_text:script,spoken_text:options.spoken??script,dur_s,audio_path,subtitle_text:extra.subtitleText==null?null:subtitles.autoRunSubtitle(extra.subtitleText),review_state:'candidate',game_zh_text_snapshot:line.productionScript?line.productionScript.originalChinese:line.text_zh,conversion_meta:{post_stretch:1}};
   files.set(audio_path,audio(dur_s));clips.set(id,clip);calls.native.push(clip);return clip;
  });
 });
 api.hooks.setAsr(async clip=>{
  assert.equal(context.currentChatModel(),'grok');calls.asr.push(clip.audio_path);
  if(options.markDuringAsr)marked=true;
  if(options.asrError)throw Error('ASR unavailable');
  const audioSha256=crypto.createHash('sha256').update(files.get(clip.audio_path)).digest('hex');
  if(options.manualSubtitleAfterAsr)clip.subtitle_text='核字后人工改的字幕';
  if(options.manualAudioAfterAsr)files.set(clip.audio_path,audio(6.125));
  return {text:options.asrTextForClip?options.asrTextForClip(clip):options.failEdited&&clip.edited?'漏字':clip.spoken_text,audioSha256};
 });
 return {api,calls,clips,files,line,get finished(){return finished;}};
}
test('explicit field review pins Grok, verifies saved original compression, and atomically locks with grouping and metrics',async()=>{
 const h=harness({metrics:{tokens:{total:123},speed:{seconds:2}}});
 await context.withChatModel('volcengine',()=>h.api.executeCasualDurationReview('run','TEST'));
 assert.equal(h.calls.tts.length,1);assert.equal(h.calls.edits.length,1);
 assert.deepEqual(h.calls.asr,['tts/TEST/1.wav','tts/TEST/2.wav']);
 assert.equal(h.calls.edits[0].source_id,'1');assert.equal(h.calls.edits[0].ratio,.9);assert.equal(h.calls.edits[0].target_frames,9000);
 const editedMeta=h.clips.get('2').conversion_meta;
 assert.equal(editedMeta.post_stretch,.9);assert.equal(editedMeta.post_stretch,editedMeta.ratio);
 assert.equal(h.clips.get('1').conversion_meta.post_stretch,1);
 assert.equal(editedMeta.workflow,'casual-duration-review-v2');
 assert.equal(editedMeta.compression.source_duration_s,10);assert.equal(editedMeta.compression.target_duration_s,9);
 assert.equal(editedMeta.compression.target_semantics,'full-original-jp-total-duration-ceiling');
 assert.equal(editedMeta.compression.tolerance_s,.001);
 assert.equal(h.clips.get('2').review_state,'locked');assert.equal(h.clips.get('2').used_at,'now');assert.equal(h.clips.get('1').review_state,'candidate');assert.equal(h.clips.get('1').parent_tts_id,'2');
 assert.equal(h.files.get('tts/TEST/1.wav').toString(),'10000');assert.equal(h.files.get('tts/TEST/2.wav').toString(),'9000');
 assert.equal(h.finished[0],'passed');assert.equal(h.finished[2],'2');
 assert.equal(h.clips.get('2').subtitle_text,null);assert.deepEqual(h.clips.get('2').llm_tokens,{total:123});assert.deepEqual(h.clips.get('2').llm_speed,{seconds:2});
 assert.equal(h.clips.get('1').llm_tokens,null);
 assert.ok(h.calls.events.some(e=>e[2]?.reviewState==='locked'&&e[2].decisionReason.includes('自动锁定')));
});
test('over 10 percent rewrite receives measured feedback and final subtitle follows rewritten script',async()=>{
 const h=harness({duration:n=>n<=3?12:8,target:9});
 await h.api.executeCasualDurationReview('run','TEST');
 const feedback=h.calls.rewrites[0];
 assert.equal(feedback.measuredSeconds,12);assert.equal(feedback.targetSeconds,9);assert.ok(Math.abs(feedback.overrunPercentage-100/3)<1e-10);
 assert.equal(feedback.currentCharacterCount,7);assert.ok(feedback.estimatedReductionPercentage>0);assert.ok(feedback.maxCharacters<7);
 assert.equal(h.calls.edits.length,0);assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
 assert.equal(h.clips.get(h.finished[2]).subtitle_text,'完整中文');
});
test('failed compression nuclear checks stay failed; only complete raw evidence may justify later rewriting',async()=>{
 const h=harness({duration:10,failEdited:true});
 await h.api.executeCasualDurationReview('run','TEST');
 assert.equal(h.calls.tts.length,6);assert.equal(h.calls.native.length,12);assert.equal(h.calls.edits.length,12);assert.equal(h.calls.asr.length,24);assert.equal(h.calls.rewrites.length,3);
 assert.equal(new Set(h.calls.tts.slice(0,3).map(c=>c.script)).size,1);assert.equal(h.finished[0],'failed');assert.equal(h.clips.get(h.finished[2]).review_state,'abnormal');
});
test('ASR service failure retains generated audio for abnormal review and retries unchanged text',async()=>{
 const h=harness({asrError:true});await h.api.executeCasualDurationReview('run','TEST');
 assert.equal(h.calls.tts.length,3);assert.equal(h.calls.rewrites.length,0);assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);assert.ok(h.clips.size>0);
});
test('manual marks during ASR or final transaction win with no automatic recommendation',async()=>{
 for(const options of [{markDuringAsr:true},{duration:8,markAtCommit:true},{markAtCommit:true}]) {
  const h=harness(options);await h.api.executeCasualDurationReview('run','TEST');
  assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);assert.equal(h.calls.edits.length,0);
  assert.ok([...h.clips.values()].every(c=>c.review_state==='candidate'));
 }
});
test('no generated audio never fabricates completion or abnormal selection',async()=>{
 const h=harness({noAudio:true});await h.api.executeCasualDurationReview('run','TEST');
 assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);assert.equal(h.clips.size,0);
});
test('standard field original pass uses duration workflow and locks with Grok only',async()=>{
 const h=harness({duration:8});await h.api.executeAutoRun('run','TEST');
 assert.equal(h.calls.tts.length,1);assert.equal(h.calls.tts[0].extra.feedbackRound,true);
 assert.deepEqual(h.calls.referenceFiles,['jp/TEST.mp3']);
 assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
});

const translationSource=()=>({kind:'model-translation',language:'jp',originalChinese:'',sourceText:'原文',sourceTextSha256:crypto.createHash('sha256').update('原文').digest('hex'),
 translation:'模型给出的制作起稿',translationSha256:crypto.createHash('sha256').update('模型给出的制作起稿').digest('hex'),translationEventId:'25',model:'local27b',sourceAudioPath:'jp/TEST.mp3',sourceAudioSha256:crypto.createHash('sha256').update('9000').digest('hex'),asrEventId:'24'});
test('missing original Chinese uses model baseline, saves real empty original snapshot and locks without inventing original meaning review',async()=>{
 const source=translationSource(),h=harness({productionScript:source,duration:8});await h.api.executeAutoRun('run','TEST');
 assert.equal(h.finished[0],'passed');const clip=h.clips.get(h.finished[2]);assert.equal(clip.review_state,'locked');assert.equal(clip.game_zh_text_snapshot,'');assert.equal(clip.subtitle_text,source.translation);
 assert.equal(clip.conversion_meta.production_script.translationEventId,'25');assert.equal(clip.conversion_meta.semantic_review.originalMeaningChecked,false);assert.equal(h.calls.semanticRequests.length,0);
});
test('rewritten model baseline may lock by actual current-script ASR/time without comparing rewrite meaning to the nonexistent original',async()=>{
 const h=harness({productionScript:translationSource(),duration:n=>n<=3?12:8,rewriteText:'自然短稿'});await h.api.executeAutoRun('run','TEST');
 assert.equal(h.finished[0],'passed');const clip=h.clips.get(h.finished[2]);assert.equal(clip.review_state,'locked');assert.equal(clip.spoken_text,'自然短稿');assert.equal(clip.game_zh_text_snapshot,'');assert.equal(h.calls.rewrites[0].originalChinese,null);assert.equal(h.calls.rewrites[0].checkOriginalMeaning,false);assert.equal(Object.hasOwn(h.calls.rewrites[0],'before'),false);assert.equal(Object.hasOwn(h.calls.rewrites[0],'after'),false);assert.equal(h.calls.queries.some(q=>q.includes('l.id BETWEEN')),false);assert.equal(h.calls.semanticRequests.length,0);assert.equal(clip.conversion_meta.semantic_review.originalMeaningChecked,false);
});
test('model-baseline rewrite reads a real NULL Chinese context row without the legacy missing-original blocker',async()=>{
 const h=harness({productionScript:{...translationSource(),originalChinese:null},duration:n=>n<=3?12:8,rewriteText:'精简译稿'});await h.api.executeAutoRun('run','TEST');
 assert.equal(h.finished[0],'passed');assert.equal(h.calls.rewrites.length,1);const clip=h.clips.get(h.finished[2]);assert.equal(clip.game_zh_text_snapshot,null);assert.equal(clip.review_state,'locked');assert.equal(clip.spoken_text,'精简译稿');
});
test('missing original Chinese never exempts reading uncertainty or permits deleting text to hide it',async()=>{
 const h=harness({productionScript:translationSource(),duration:8,asrTextForClip:()=> '不确定的实际转写',judgeResult:{ok:true,reason:'近音待确认',pronunciationNotes:['实义近音']},semanticReview:{faithful:true,readingEquivalent:false,needsHuman:true,readingUncertain:true,hardReadingRisk:true,negationChanged:false,questionChanged:false,entityChanged:false,missingMeaning:[],addedMeaning:[],changedMeaning:[],reason:'当前稿与实际ASR读音不确定'}});
 await h.api.executeAutoRun('run','TEST');assert.equal(h.finished[0],'failed');assert.equal(h.calls.tts.length,3);assert.equal(h.calls.rewrites.length,0);assert.ok([...h.clips.values()].every(c=>c.review_state!=='locked'));assert.ok(h.calls.semanticRequests.every(i=>i.checkOriginalMeaning===false));
});
test('human fills original Chinese at final commit of a model-baseline run: no lock and no automatic recommendation',async()=>{
 const h=harness({productionScript:translationSource(),duration:8,modelSourceChangedAtCommit:true});await h.api.executeAutoRun('run','TEST');
 assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);assert.ok([...h.clips.values()].every(c=>c.review_state!=='locked'));
});
test('actual RubberBand WAV compression fits floored JP frames at .90 and near-unity without changing pitch',()=>{
 const core=compile('rubberband-core'),server=compile('rubberband-server',{'./rubberband-core':core});
 const wav=compile('wav-stretch',{'./tts-gpu':compile('tts-gpu'),'./rubberband-server':server});
 for(const rate of [24000,44100])for(const target of [.9,.99891]) {
  const samples=Float32Array.from({length:rate},(_,i)=>.4*Math.sin(2*Math.PI*440*i/rate));
  const input=wav.encodeWavMono(rate,samples),plan=workflow.casualCompressionPlan(samples.length,rate,target);
  const edited=wav.decodeWavMono(wav.stretchWav(input,plan.ratio));
  assert.equal(edited.samples.length,Math.floor(target*rate));assert.ok(edited.samples.length/rate<=target);
  const start=Math.floor(edited.samples.length*.2),end=Math.floor(edited.samples.length*.8);let crossings=0;
  for(let i=start+1;i<end;i++)if(edited.samples[i-1]<=0&&edited.samples[i]>0)crossings++;
  assert.ok(Math.abs(crossings*rate/(end-start)-440)<8);
  assert.equal(wav.decodeWavMono(input).samples.length,rate);
 }
});
test('explicit ordinary review accepts every nonperformance mode and rejects scene/mixed before inference',async()=>{
 for(const mode of ['field','unknown','battle','voice-bank','event',null,'']) {
  const h=harness({mode,duration:8});await h.api.executeCasualDurationReview('run','TEST');
  assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
 }
 for(const mode of ['scene','mixed']) {
  const h=harness({mode,italic:true});await assert.rejects(h.api.executeCasualDurationReview('run','TEST'),/非场景演出/);
  assert.equal(h.calls.tts.length,0);assert.equal(h.calls.jpAsr.length,0);
 }
});

test('HTTP clone request explicitly propagates Grok to nested model tasks',async()=>{
 const h=harness({duration:8});await h.api.executeCasualDurationReview('run','TEST');
 const previousFetch=global.fetch;
 global.fetch=async(_url,options)=>{
  const body=JSON.parse(options.body);assert.equal(body.autoRunModel,'grok');assert.equal(body.autoRunId,'run');assert.equal(body.feedbackRound,true);
  return {ok:true,json:async()=>({ids:['1']})};
 };
 try {
  const clips=await context.withChatModel('grok',()=>h.api.hooks.generateClone('run','TEST','完整的中文原稿',{feedbackRound:true}));
  assert.equal(clips.length,1);
 } finally {global.fetch=previousFetch;}
});

test('ready metadata without a nonempty audio file cannot become the selected output',async()=>{
 const h=harness({duration:8,missingFinal:true});await h.api.executeCasualDurationReview('run','TEST');
 assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);assert.equal(h.clips.get('1').review_state,'candidate');
});

const originalCn=Buffer.from('49443304000000000023fffb90a40001abcdef0000','hex');
function assertNoModels(h) {
 assert.equal(h.calls.tts.length,0);assert.equal(h.calls.asr.length,0);assert.equal(h.calls.jpAsr.length,0);assert.equal(h.calls.rewrites.length,0);assert.equal(h.calls.judges.length,0);
 assert.equal(h.calls.queries.some(q=>q.includes('FROM pronunciations')),false);
}
test('exact all-zero ordinary JP locks byte-identical JP without Chinese audio or any inference',async()=>{
 const h=harness({jpAllZero:true,target:1});
 await h.api.executeCasualDurationReview('run','TEST');
 assertNoModels(h);assert.equal(h.finished[0],'passed');assert.equal(h.finished[1],null);
 const clip=h.clips.get(h.finished[2]);assert.ok(clip);assert.equal(clip.voice_gpu_key,'jp-lock');assert.equal(clip.auto_run_id,'run');
 assert.equal(clip.review_state,'locked');assert.equal(clip.subtitle_text,null);
 assert.equal(clip.jp_text_snapshot,h.line.text_jp);assert.equal(clip.game_zh_text_snapshot,h.line.text_zh);
 assert.equal(clip.tts_text,h.line.text_zh);assert.ok(clip.audio_path.endsWith('.mp3'));
 assert.deepEqual(h.files.get(clip.audio_path),h.files.get('jp/TEST.mp3'));
 assert.deepEqual(h.calls.referenceFiles,['jp/TEST.mp3']);
 const meta=clip.conversion_meta;
 assert.equal(meta.pipeline,'jp-lock');assert.equal(meta.workflow,'casual-zero-japanese-original-v1');assert.match(meta.reason,/PCM精确全零/);
 assert.equal(meta.target_duration_s,undefined);assert.equal(meta.duration_review,undefined);
 assert.equal(meta.speech_pass,undefined);assert.equal(meta.asr,undefined);
});
test('zero JP preserves original JP regardless of missing or silent CN',async()=>{
 for(const options of [{},{cnSource:originalCn,cnSilent:true}]) {
  const h=harness({jpAllZero:true,target:1,...options});await h.api.executeCasualDurationReview('run','TEST');
  assertNoModels(h);assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).voice_gpu_key,'jp-lock');
 }
});
test('manual marks before zero-JP processing or locking transaction win',async()=>{
 for(const guard of [{markedAtStart:true},{markAtCommit:true}]) {
  const h=harness({jpAllZero:true,target:1,cnSource:originalCn,...guard});await h.api.executeCasualDurationReview('run','TEST');
  assertNoModels(h);assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);
  assert.ok([...h.clips.values()].every(c=>c.review_state==='candidate'));
  if(guard.markedAtStart)assert.equal(h.clips.size,0);
 }
});
test('standard field zero-JP path also preserves and locks original JP',async()=>{
 const h=harness({jpAllZero:true,target:1,cnSource:originalCn});await h.api.executeAutoRun('run','TEST');
 assertNoModels(h);assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
});
test('any nonzero JP sample, even extremely quiet, retains the ordinary synthesis path',async()=>{
 const h=harness({jpSample:1e-12,duration:8});await h.api.executeCasualDurationReview('run','TEST');
 assert.equal(h.calls.tts.length,1);assert.equal(h.finished[0],'passed');
 assert.ok([...h.clips.values()].every(c=>c.voice_gpu_key!=='cn-original'));
});

test('explicit field original pass locks with original subtitle and logs the actual decision',async()=>{
 const h=harness({duration:8});await h.api.executeCasualDurationReview('run','TEST');
 const clip=h.clips.get(h.finished[2]);assert.equal(clip.review_state,'locked');assert.equal(clip.used_at,'now');assert.equal(clip.subtitle_text,null);
 const event=h.calls.events.find(e=>e[2]?.reviewState==='locked');assert.equal(event[2].reviewState,'locked');assert.match(event[1],/自动锁定/);assert.doesNotMatch(event[1],/异常/);
});
test('same-text retries can lock once the complete audio passes',async()=>{
 const h=harness({duration:8});
 const originalAsr=h.api.hooks;let reads=0;
 originalAsr.setAsr(async clip=>({text:++reads===1?'漏字':clip.spoken_text,audioSha256:crypto.createHash('sha256').update(h.files.get(clip.audio_path)).digest('hex')}));
 await h.api.executeCasualDurationReview('run','TEST');
 assert.equal(h.calls.tts.length,2);assert.equal(new Set(h.calls.tts.map(c=>c.script)).size,1);assert.equal(h.calls.rewrites.length,0);
 assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
});
test('different final subtitle or changed current original explicitly fails with no recommendation',async()=>{
 for(const options of [{finalSubtitle:'人工修改的另一段字幕'},{currentOriginal:'期间人工更新了原文'}]) {
  const h=harness({duration:8,...options});await h.api.executeCasualDurationReview('run','TEST');
  assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);assert.equal(h.calls.grouping.length,0);
  if(options.finalSubtitle)assert.equal(h.clips.get('1').subtitle_text,options.finalSubtitle);
 }
});
test('original body comparison removes punctuation/symbols/whitespace but never applies NFKC or synonyms',async()=>{
 for(const [originalText,spoken,expected] of [['「原 文」，★','原文','locked'],['Ａ台词','A台词','abnormal'],['原始台词','原来台词','abnormal']]) {
  const h=harness({duration:8,originalText,spoken});await h.api.executeCasualDurationReview('run','TEST');
  if(expected==='locked'){assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');}
  else {assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);}
 }
});

test('cleaned reference and body script reach every TTS request, then original edges restore full script and subtitle',async()=>{
 const h=harness({cleanup:true,originalText:'嗯，完整的中文原稿',duration:7,target:9});
 await h.api.executeCasualDurationReview('run','TEST');
 assert.equal(h.calls.jpAsr.length,2);
 assert.deepEqual(h.calls.jpAsr[0].params,{useForcedAligner:true});assert.equal(h.calls.jpAsr[1].params,undefined);
 assert.equal(h.calls.tts.length,1);assert.equal(h.calls.tts[0].script,'完整的中文原稿');
 const extra=h.calls.tts[0].extra;assert.equal(extra.preservePromptAudio,true);assert.equal(extra.feedbackRound,true);assert.equal(extra.alignStartS,null);
 assert.equal(extra.subtitleText,'完整的中文原稿');
 assert.match(extra.promptPath,/auto-run-run-casual-cleanup-prompt\.wav$/);
 assert.deepEqual(h.calls.referenceRecords,[{promptPath:extra.promptPath,textJp:'日文正文'}]);
 assert.ok(h.calls.queries.some(q=>q.includes('UPDATE line_auto_runs SET reference_audio_path')&&q.includes('reference_seed_asr=NULL')&&q.includes("AND status='running'")));
 assert.equal(h.files.get(extra.promptPath).toString(),'7000');
 assert.equal(h.calls.assemblies.length,1);assert.equal(h.calls.edits.length,1);
 const final=h.clips.get(h.finished[2]);assert.equal(final.spoken_text,'嗯，完整的中文原稿');assert.equal(final.tts_text,'嗯，完整的中文原稿');
 assert.equal(final.subtitle_text,null);assert.equal(final.review_state,'locked');
 assert.equal(final.dur_s,9);assert.equal(final.conversion_meta.operation,'casual-original-edges-assembly');
 assert.equal(final.conversion_meta.body_script,'完整的中文原稿');assert.equal(final.conversion_meta.component_verified,true);
 assert.equal(final.conversion_meta.body_budget_s,7);assert.equal(final.conversion_meta.original_total_ceiling_s,9);
 assert.equal(h.files.get('tts/TEST/1.wav').toString(),'7000');assert.equal(h.files.get(final.audio_path).toString(),'9000');
});

test('JP alignment failure, unsupported evidence, or failed cleaned-reference re-listen falls back to original inputs',async()=>{
 for(const opts of [{jpAsrError:true},{cleanup:false},{cleanup:true,referenceAsrText:'漏掉日文正文'}]) {
  const h=harness({target:9,duration:8,...opts});await h.api.executeCasualDurationReview('run','TEST');
  assert.equal(h.calls.tts[0].script,h.line.text_zh);assert.equal(h.calls.tts[0].extra.promptPath,undefined);
  assert.equal(h.calls.assemblies.length,0);assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
 }
});

test('only Chinese body is compressed and checked anew; preserved original time is subtracted from the budget',async()=>{
 const h=harness({cleanup:true,originalText:'嗯，完整的中文原稿',target:9,duration:7.5});
 await h.api.executeCasualDurationReview('run','TEST');
 assert.equal(h.calls.tts.length,1);assert.equal(h.calls.edits.length,2);assert.equal(h.calls.asr.length,2);
 const shortened=h.calls.edits[0];assert.equal(shortened.body_only,true);assert.equal(shortened.target_duration_s,7);
 assert.equal(shortened.compression.target_semantics,'cleaned-jp-body-duration-ceiling');assert.equal(shortened.original_total_ceiling_s,9);
 assert.equal(h.calls.assemblies[0].body.toString(),'7000');assert.equal(h.calls.edits[1].operation,'casual-original-edges-assembly');
 assert.equal(h.clips.get(h.finished[2]).dur_s,9);assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
});

test('rewrites receive cleaned originals and cannot reinsert preserved words into TTS',async()=>{
 const h=harness({cleanup:true,originalText:'嗯，完整的中文原稿',target:9,duration:n=>n<=3?9:6});
 await h.api.executeCasualDurationReview('run','TEST');
 assert.equal(h.calls.rewrites[0].originalChinese,'完整的中文原稿');assert.equal(h.calls.rewrites[0].japanese,'日文正文');
 assert.equal(h.calls.rewrites[0].targetSeconds,7);assert.equal(h.calls.rewrites[0].originalTotalSeconds,9);
 assert.equal(h.calls.rewrites[0].preservedChinesePrefix,'嗯，');
 assert.deepEqual(h.calls.tts.map(c=>c.script),['完整的中文原稿','完整的中文原稿','完整的中文原稿','完整中文']);
 assert.ok(h.calls.tts.every(c=>c.extra.preservePromptAudio&&c.extra.promptPath));
 const final=h.clips.get(h.finished[2]);assert.equal(final.spoken_text,'嗯，完整中文');assert.equal(final.subtitle_text,'嗯，完整中文');
 assert.equal(final.review_state,'locked');assert.equal(final.dur_s,8);
});

test('failed assembly, non-exact preserved PCM, or assembled total overrun never selects an unassembled body',async()=>{
 for(const opt of [{assemblyFailure:true},{badPcm:true},{assemblyOverrun:true},{duration:8.5}]) {
  const h=harness({cleanup:true,originalText:'嗯，完整的中文原稿',target:9,duration:7,...opt});
  await h.api.executeCasualDurationReview('run','TEST');
  assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);assert.ok(h.clips.size>=1);
  assert.ok([...h.clips.values()].every(c=>c.review_state==='candidate'));
 }
});

test('manual state during Japanese preprocessing stops before TTS; final selection still honors a late manual choice',async()=>{
 for(const opt of [{markDuringJpAsr:true},{markAtCommit:true}]) {
  const h=harness({cleanup:true,originalText:'嗯，完整的中文原稿',duration:7,...opt});
  await h.api.executeCasualDurationReview('run','TEST');
  assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);
  if(opt.markDuringJpAsr)assert.equal(h.calls.tts.length,0);
  assert.ok([...h.clips.values()].every(c=>c.review_state==='candidate'));
 }
});

test('ASR-origin Japanese cannot authorize unclassified edge extraction even when text matches',async()=>{
 const h=harness({cleanup:true,cleanupKind:'unclassified',duration:8,extra:{remake_preprocess:{asr:{original_japanese_subtitle_missing:true,text_jp_filled:true}}}});
 await h.api.executeCasualDurationReview('run','TEST');
 assert.equal(h.calls.cleanupPlans[0].allowUnclassifiedEdges,false);assert.equal(h.calls.tts[0].extra.promptPath,undefined);
 assert.equal(h.calls.assemblies.length,0);assert.equal(h.calls.jpAsr.length,1);
});

test('Remake official-source evidence is explicit while ambiguous origin never grants edge extraction',()=>{
 const before=process.env.FF7_GAME_ID;process.env.FF7_GAME_ID='remake';
 try {
  const h=harness(),evidence=h.api.hooks.casualJapaneseTextEvidence;
  assert.equal(evidence({...h.line,extra:{}}).allowUnclassifiedEdges,false);
  const official={game_id:'remake',audio_extraction:{},official_text_evidence:{JP:{id:'official-jp'}}};
  assert.equal(evidence({...h.line,extra:official}).allowUnclassifiedEdges,true);
  for(const asr of [{original_japanese_subtitle_missing:true},{text_jp_filled:true}])
   assert.equal(evidence({...h.line,extra:{...official,remake_preprocess:{asr}}}).allowUnclassifiedEdges,false);
 } finally {if(before===undefined)delete process.env.FF7_GAME_ID;else process.env.FF7_GAME_ID=before;}
});

test('italic ordinary dialogue uses cleanup and restoration without lip-sync',async()=>{
 const h=harness({mode:'unknown',italic:true,cleanup:true,originalText:'嗯，完整的中文原稿',duration:7,target:9});
 await h.api.executeAutoRun('run','TEST');
 assert.equal(h.calls.tts.length,1);assert.equal(h.calls.tts[0].extra.feedbackRound,true);assert.equal(h.calls.tts[0].extra.alignStartS,null);
 assert.equal(h.calls.assemblies.length,1);assert.equal(h.calls.edits.filter(e=>e.operation==='casual-speech-compression').length,0);
 assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
});

test('Grok cannot re-add literal preserved head words and hide the failed body as a final candidate',async()=>{
 const h=harness({cleanup:true,originalText:'嗯，完整的中文原稿',duration:9,target:9,rewriteText:'嗯，完整中文'});
 await h.api.executeCasualDurationReview('run','TEST');
 assert.equal(h.calls.tts.length,3);assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);
 assert.ok(h.calls.events.some(values=>values.some(value=>typeof value==='string'&&value.includes('正文超过可用时长'))));
});

test('a manual choice after assembled audio is saved wins at final commit for field and italic',async()=>{
 for(const options of [{mode:'field'},{mode:'unknown',italic:true}]) {
  const h=harness({cleanup:true,originalText:'嗯，完整的中文原稿',duration:7,target:9,markAfterAssemblySave:true,...options});
  await h.api.executeAutoRun('run','TEST');
  assert.equal(h.calls.assemblies.length,1);assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);
  assert.ok([...h.clips.values()].every(c=>c.review_state==='candidate'));
 }
});

test('ordinary italic finish acquires line, run, then version locks in the shared save order',async()=>{
 const h=harness({mode:'unknown',italic:true,cleanup:true,originalText:'嗯，完整的中文原稿',duration:7,target:9});
 await h.api.executeAutoRun('run','TEST');
 const finalTx=h.calls.transactions.at(-1);
 const line=finalTx.findIndex(q=>q.includes('SELECT stem,text_zh,text_jp,text_en,translate_zh_jp,translate_zh_en FROM lines')&&q.includes('FOR UPDATE'));
 const run=finalTx.findIndex(q=>q.includes('SELECT id FROM line_auto_runs')&&q.includes('FOR UPDATE'));
 const versions=finalTx.findIndex(q=>q.includes("review_state IN ('locked','abnormal')")&&q.includes('FOR UPDATE'));
 assert.ok(line>=0&&line<run&&run<versions,JSON.stringify(finalTx));
 assert.equal(h.finished[0],'passed');
});

test('TTS quota failure after a cleaned-body candidate cannot escape to the outer whole-audio fallback',async()=>{
 for(const options of [{mode:'field'},{mode:'unknown',italic:true}]) {
  const h=harness({cleanup:true,originalText:'嗯，完整的中文原稿',duration:7,target:9,asrError:true,budgetOnCall:2,...options});
  await h.api.executeAutoRun('run','TEST');
  assert.equal(h.calls.tts.length,2);assert.equal(h.clips.size,1);assert.equal(h.calls.budgetFallback,0);
  assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);
  assert.match(h.finished[1],/24条上限/);assert.equal(h.clips.get('1').review_state,'candidate');
 }
});

test('an unlocked manual body subtitle change is preserved both before assembly and in the final-save window',async()=>{
 for(const opts of [{manualSubtitleAfterAsr:true},{manualSubtitleAtSave:true}]) {
  const h=harness({cleanup:true,originalText:'嗯，完整的中文原稿',duration:7,target:9,...opts});
  await h.api.executeCasualDurationReview('run','TEST');
  assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);assert.equal(h.clips.size,1);
  assert.equal(h.clips.get('1').review_state,'candidate');assert.match(h.clips.get('1').subtitle_text,/人工改的字幕/);
  assert.match(h.finished[1],/字幕.*人工修改/);assert.equal(h.calls.edits.length,0);
 }
});

test('overwriting an unlocked verified body file cannot reuse its stale text pass or create a final output',async()=>{
 const h=harness({cleanup:true,originalText:'嗯，完整的中文原稿',duration:7,target:9,manualAudioAfterAsr:true});
 await h.api.executeCasualDurationReview('run','TEST');
 assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);assert.equal(h.clips.size,1);
 assert.equal(h.calls.assemblies.length,0);assert.equal(h.calls.edits.length,0);
 assert.equal(h.files.get('tts/TEST/1.wav').toString(),'6125');assert.equal(h.clips.get('1').review_state,'candidate');
 assert.match(h.finished[1],/音频已变化|核字SHA|审稿期间已变化/);
});

test('ASR helper binds SHA to the exact bytes sent even if the file changes while the request is pending',async()=>{
 const h=harness({duration:8,mutateDuringActualAsr:true});await h.api.executeCasualDurationReview('run','TEST');
 const before=Buffer.from(h.files.get('tts/TEST/1.wav'));
 const result=await h.api.hooks.originalAsrQwen(h.clips.get('1'));
 assert.equal(result.audioSha256,crypto.createHash('sha256').update(before).digest('hex'));
 assert.deepEqual(Buffer.from(h.calls.actualBodyApi.at(-1).b64,'base64'),before);
 assert.notEqual(result.audioSha256,crypto.createHash('sha256').update(h.files.get('tts/TEST/1.wav')).digest('hex'));
 assert.equal(result.text,'实际转写');
});

for(const mode of ['unknown','battle','voice-bank','event',null,''])test(`all ordinary automatic modes use the same full workflow and original auto-lock: ${mode}`,async()=>{
 const h=harness({mode,duration:10});await h.api.executeAutoRun('run','TEST');
 assert.equal(h.calls.tts.length,1);assert.equal(h.calls.edits.length,1);assert.equal(h.calls.rewrites.length,0);
 assert.equal(h.calls.tts[0].extra.feedbackRound,true);assert.equal(h.calls.tts[0].extra.alignStartS,null);
 assert.equal(h.calls.edits[0].ratio,.9);assert.equal(h.calls.asr.length,2);
 assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
 assert.equal(h.calls.events.filter(e=>e.includes('model-stage-start')).length,1);
 assert.equal(h.line.dialogue_mode,mode);
});
test('non-field original changes during processing prevent automatic lock against an outdated source',async()=>{
 const h=harness({mode:'battle',duration:8,currentOriginal:'期间人工改过的新原文'});await h.api.executeAutoRun('run','TEST');
 assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);
});
test('ordinary unknown cleanup shortens only the body then restores original edges before automatic locking',async()=>{
 const h=harness({mode:'unknown',cleanup:true,originalText:'嗯，完整的中文原稿',duration:7.7,target:9});
 await h.api.executeAutoRun('run','TEST');
 assert.equal(h.calls.edits.filter(e=>e.operation==='casual-speech-compression').length,1);
 assert.equal(h.calls.assemblies.length,1);assert.equal(h.calls.asr.length,2);
 assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
 assert.equal(h.clips.get(h.finished[2]).spoken_text,h.line.text_zh);
});

test('native 22050 body gets an independent normalized version before verification and assembly',async()=>{
 const h=harness({cleanup:true,normalizeBody:true,originalText:'嗯，完整的中文原稿',duration:7,target:9});
 await h.api.executeAutoRun('run','TEST');
 assert.equal(h.calls.tts.length,1);assert.deepEqual(h.calls.asr,['tts/TEST/2.wav']);
 const normalized=h.calls.edits.find(e=>e.operation==='casual-body-format-normalization');
 assert.equal(normalized.source_id,'1');assert.equal(normalized.source_format.sample_rate,22050);assert.equal(normalized.normalized_format.sample_rate,24000);
 assert.equal(normalized.normalization.before_verification,true);
 assert.equal(normalized.normalized_audio_sha256,crypto.createHash('sha256').update(h.files.get('tts/TEST/2.wav')).digest('hex'));
 const assembled=h.calls.edits.find(e=>e.operation==='casual-original-edges-assembly');
 assert.equal(assembled.source_id,'2');assert.equal(assembled.body_audio_sha256,normalized.normalized_audio_sha256);
 assert.equal(assembled.body_asr_input_sha256,normalized.normalized_audio_sha256);
 assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
 assert.equal(h.clips.get('1').review_state,'candidate');assert.equal(h.clips.get('2').review_state,'candidate');
});
test('normalization actual duration over budget by more than 1ms is shortened and verified before assembly',async()=>{
 const h=harness({cleanup:true,normalizeBody:true,normalizedExtraSeconds:.01,originalText:'嗯，完整的中文原稿',duration:7,target:9});
 await h.api.executeAutoRun('run','TEST');
 assert.equal(h.calls.tts.length,1);assert.deepEqual(h.calls.asr,['tts/TEST/2.wav','tts/TEST/3.wav']);
 const normalization=h.calls.edits.find(e=>e.operation==='casual-body-format-normalization');
 assert.equal(normalization.duration_before_s,7);assert.equal(normalization.duration_after_s,7.01);
 const compression=h.calls.edits.find(e=>e.operation==='casual-speech-compression');
 assert.equal(compression.source_id,'2');assert.equal(compression.source_duration_s,7.01);assert.equal(compression.duration_after_s,7);
 assert.equal(h.calls.assemblies[0].body,h.files.get('tts/TEST/3.wav'));
 assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
});
test('normalization never edits ordinary audio without cleanup or canonical already-normalized audio',async()=>{
 const whole=harness({normalizeBody:true,duration:8});await whole.api.executeAutoRun('run','TEST');
 assert.equal(whole.calls.normalizations.length,0);assert.deepEqual(whole.calls.asr,['tts/TEST/1.wav']);
 const canonical=harness({cleanup:true,originalText:'嗯，完整的中文原稿',duration:7,target:9});await canonical.api.executeAutoRun('run','TEST');
 assert.equal(canonical.calls.normalizations[0].changed,false);assert.deepEqual(canonical.calls.asr,['tts/TEST/1.wav']);
 assert.equal(canonical.calls.edits.filter(e=>e.operation==='casual-body-format-normalization').length,0);
});
test('normalization save refuses changed source bytes, source subtitles or human state before any body ASR',async()=>{
 for(const options of [{mutateDuringNormalization:true},{manualSubtitleAtSave:true},{markDuringNormalization:true}]) {
  const h=harness({cleanup:true,normalizeBody:true,originalText:'嗯，完整的中文原稿',duration:7,target:9,...options});
  await h.api.executeAutoRun('run','TEST');
  assert.equal(h.calls.asr.length,0);assert.equal(h.calls.edits.length,0);assert.equal(h.calls.assemblies.length,0);
  assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);
 }
});
test('normalized body cannot be swapped after its own ASR to reuse the earlier text result',async()=>{
 const h=harness({cleanup:true,normalizeBody:true,manualAudioAfterAsr:true,originalText:'嗯，完整的中文原稿',duration:7,target:9});
 await h.api.executeAutoRun('run','TEST');assert.deepEqual(h.calls.asr,['tts/TEST/2.wav']);
 assert.equal(h.calls.assemblies.length,0);assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);
 assert.match(h.finished[1],/核字SHA|审稿期间已变化/);
});
test('normalization overrun beyond allowed compression feeds actual normalized duration to Grok and retries',async()=>{
 const h=harness({cleanup:true,normalizeBody:true,normalizedExtraSeconds:1.5,originalText:'嗯，完整的中文原稿',duration:n=>n<=3?7:5,target:9});
 await h.api.executeAutoRun('run','TEST');
 assert.equal(h.calls.tts.length,4);assert.equal(h.calls.rewrites.length,1);
 assert.equal(h.calls.rewrites[0].measuredSeconds,8.5);assert.equal(h.calls.rewrites[0].targetSeconds,7);
 assert.equal(h.calls.edits.filter(e=>e.operation==='casual-speech-compression').length,0);
 assert.deepEqual(h.calls.asr,['tts/TEST/2.wav','tts/TEST/4.wav','tts/TEST/6.wav','tts/TEST/10.wav','tts/TEST/11.wav','tts/TEST/12.wav']);assert.equal(h.finished[0],'passed');
 assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
});

test('every original and rewritten candidate gets align, its own nuclear check and optional independent compression',async()=>{
 const h=harness({alignmentRemovedSeconds:.1,duration:n=>n<=3?12:9.8});await h.api.executeAutoRun('run','TEST');
 assert.deepEqual(h.calls.tts.map(c=>c.extra.candidateCount),[1,1,1,3]);assert.equal(h.calls.native.length,6);
 assert.equal(h.calls.alignments.length,6);assert.equal(h.calls.edits.filter(e=>e.operation==='casual-single-slot-alignment').length,6);
 assert.equal(h.calls.edits.filter(e=>e.operation==='casual-speech-compression').length,3);
 assert.equal(h.calls.asr.length,9);assert.equal(new Set(h.calls.asr).size,9);
 assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
 assert.ok(h.calls.tts.every(c=>c.extra.feedbackRound===true&&c.extra.alignStartS===null));
});
test('three-choice quality gate uses pronunciation doubts and stable order after every candidate verification',async()=>{
 const h=harness({duration:n=>n<=3?12:8,asrTextForClip:clip=>clip.id==='4'?'读音疑点':clip.spoken_text,judgeResult:{ok:true,reason:'同音复核',pronunciationNotes:['疑点'],pronunciationIssueCount:1}});
 await h.api.executeAutoRun('run','TEST');assert.equal(h.calls.native.length,6);assert.equal(h.calls.asr.length,6);
 assert.equal(h.finished[0],'passed');assert.equal(h.finished[2],'5');
 const pick=h.calls.events.find(e=>e.includes('casual-candidate-pick'));
 assert.ok(pick);assert.ok(h.calls.queries.some(q=>q.includes('conversion_meta')));
});
test('unlocked source subtitle or audio changes while single-slot aligning stop the whole ordinary run with no fallback grouping',async()=>{
 for(const options of [{manualSubtitleAtSave:true},{mutateDuringNormalization:true}]) {
  const h=harness({alignmentRemovedSeconds:.2,duration:10,...options});
  if(options.mutateDuringNormalization) {
   // Mutate when the alignment transform completes, before sourceGuard acquires its version lock.
   const original=h.calls.alignments.push.bind(h.calls.alignments);h.calls.alignments.push=(input)=>{for(const [key,b]of h.files)if(key.startsWith('tts/')&&b===input)h.files.set(key,Buffer.from('11250'));return original(input);};
  }
  await h.api.executeAutoRun('run','TEST');assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);
  assert.equal(h.calls.asr.length,0);assert.equal(h.calls.grouping.length,0);assert.equal(h.calls.tts.length,1);
 }
});
test('without JP cleanup, replacing the verified final WAV cannot reuse its SHA or auto-lock',async()=>{
 const h=harness({duration:8,manualAudioAfterAsr:true});await h.api.executeAutoRun('run','TEST');
 assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);assert.equal(h.calls.grouping.length,0);assert.match(h.finished[1],/核字SHA|审稿期间已变化/);
});

test('single-slot alignment always uses current actual JP PCM, not cached timing fields',async()=>{
 const h=harness({duration:8,alignmentRemovedSeconds:.1});h.line.jp_start_s=99;h.line.jp_dur_s=999;
 await h.api.executeAutoRun('run','TEST');
 assert.equal(h.calls.alignmentReferences.length,1);assert.equal(h.calls.alignmentReferences[0].reference,h.files.get('jp/TEST.mp3'));
 assert.equal(h.calls.alignmentReferences[0].target,9);assert.deepEqual(h.calls.asr,['tts/TEST/2.wav']);
 assert.equal(h.calls.edits[0].operation,'casual-single-slot-alignment');assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
});
test('cleanup candidates align only against cleaned Japanese body before nuclear check and exact original-edge assembly',async()=>{
 const h=harness({cleanup:true,originalText:'嗯，完整的中文原稿',duration:7,alignmentRemovedSeconds:.1});
 await h.api.executeAutoRun('run','TEST');
 assert.equal(h.calls.alignmentReferences[0].target,7);assert.equal(h.calls.alignmentReferences[0].reference.toString(),'7000');
 assert.notEqual(h.calls.alignmentReferences[0].reference,h.files.get('jp/TEST.mp3'));
 assert.deepEqual(h.calls.asr,['tts/TEST/2.wav']);assert.equal(h.calls.assemblies.length,1);
 assert.equal(h.calls.edits[0].operation,'casual-single-slot-alignment');assert.equal(h.calls.edits[1].source_id,'2');
 assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
});

test('speech budget uses9s speech inside10s total, not the whole-duration ratio',async()=>{
 const allowed=harness({target:8.65,duration:10,fixedExternalSeconds:1});await allowed.api.executeAutoRun('run','TEST');
 assert.equal(allowed.calls.edits.length,1);const edit=allowed.calls.edits[0];
 assert.equal(edit.operation,'casual-speech-compression');assert.equal(edit.ratio,.85);assert.equal(edit.total_duration_ratio,.865);
 assert.equal(edit.speech_compression.speechFrames,9000);assert.equal(edit.speech_compression.targetSpeechFrames,7650);
 assert.equal(allowed.calls.asr.length,2);assert.equal(allowed.finished[0],'passed');assert.equal(allowed.clips.get(allowed.finished[2]).review_state,'locked');
 const rejected=harness({target:8.5,duration:10,fixedExternalSeconds:1});await rejected.api.executeAutoRun('run','TEST');
 assert.equal(rejected.calls.edits.length,0);assert.equal(rejected.finished[0],'failed');assert.equal(rejected.calls.tts.slice(0,3).length,3);
});

test('controlled reuse copies6475-style full original into the new run, then fresh DSP/ASR locks without any native TTS',async()=>{
 const h=harness({originalText:'不痛不痒',existingCandidates:[{id:'6475',duration:.995,conversion_meta:{tts_text_sent:'不痛不痒',duration_review:{textPassed:true,asrInputSha256:'OLD-DO-NOT-REUSE'},semantic_review:{passed:true}}}],target:.776,alignmentRemovedSeconds:.22});
 const old=JSON.parse(JSON.stringify(h.clips.get('6475'))),bytes=Buffer.from(h.files.get(old.audio_path));
 await h.api.executeAutoRun('run','TEST',{forceGenerate:true,reuseOriginalCandidates:true});
 assert.equal(h.calls.tts.length,0);assert.equal(h.calls.imports.length,1);assert.equal(h.calls.asr.length,1);assert.notEqual(h.calls.asr[0],old.audio_path);
 assert.equal(h.calls.imports[0].metadata.source_run_id,'old');assert.equal(h.calls.imports[0].metadata.source_id,'6475');
 assert.equal(h.calls.imports[0].metadata.semantic_review,undefined);assert.equal(h.calls.imports[0].metadata.duration_review,undefined);
 assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
 assert.deepEqual(h.clips.get('6475'),old);assert.deepEqual(h.files.get(old.audio_path),bytes);
});
test('changed pronunciation payload rejects old陆号 and continues new native production instead of silently skipping',async()=>{
 const h=harness({originalText:'陆号',rules:[{id:16,src:'陆号',dst:'六号',note:'编号'}],existingCandidates:[{id:'100',conversion_meta:{tts_text_sent:'陆号'}}],duration:8});
 await h.api.executeAutoRun('run','TEST',{forceGenerate:true,reuseOriginalCandidates:true});
 assert.equal(h.calls.imports.length,0);assert.equal(h.calls.tts.length,1);assert.ok(h.calls.events.some(e=>e.some(v=>v?.reason?.includes('发音规则'))));
 assert.equal(h.clips.get('100').auto_run_id,'old');
});
test('reuse defaults off, cleanup body/source ambiguity stays out of the copy pool, and old history remains immutable',async()=>{
 for(const options of [{},{cleanup:true,originalText:'嗯，完整的中文原稿',duration:7}]) {
  const h=harness({existingCandidates:[{id:'100',duration:8}],duration:8,...options});
  await h.api.executeAutoRun('run','TEST',{forceGenerate:true,reuseOriginalCandidates:!!options.cleanup});
  assert.equal(h.calls.imports.length,0);assert.ok(h.calls.tts.length>0);assert.equal(h.clips.get('100').auto_run_id,'old');
 }
});
test('source file or current Chinese changes before cross-run copy stop the whole item, never edit the source or generate a fallback',async()=>{
 for(const options of [{mutateReuseSource:true},{currentOriginal:'人工刚改过原稿'}]) {
  const h=harness({existingCandidates:[{id:'100',duration:8}],...options});
  await h.api.executeAutoRun('run','TEST',{forceGenerate:true,reuseOriginalCandidates:true});
  assert.equal(h.calls.imports.length,0);assert.equal(h.calls.tts.length,0);assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);assert.equal(h.calls.grouping.length,0);
 }
});
test('uncertain original near-sounds only retry identical script three times and never rewrite or auto-lock',async()=>{
 const bad={faithful:true,readingEquivalent:false,needsHuman:true,readingUncertain:true,hardReadingRisk:false,negationChanged:false,questionChanged:false,entityChanged:false,missingMeaning:[],addedMeaning:[],changedMeaning:[],reason:'只能与是能存在实义近音不确定'};
 const h=harness({originalText:'只能硬上了吗？',duration:8,asrTextForClip:()=> '是，能硬上了吗？',judgeResult:{ok:true,reason:'核字近音可对应',pronunciationNotes:['实义风险'],pronunciationIssueCount:1},semanticReview:bad});
 await h.api.executeAutoRun('run','TEST');assert.equal(h.calls.tts.length,3);assert.equal(h.calls.rewrites.length,0);assert.equal(h.calls.semanticRequests.length,3);
 assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);assert.ok([...h.clips.values()].every(c=>c.review_state==='candidate'));
});
test('meaning feedback repairs a truncated draft with necessary words, then only the independently approved final script locks',async()=>{
 const good={faithful:true,readingEquivalent:true,needsHuman:false,readingUncertain:false,hardReadingRisk:false,negationChanged:false,questionChanged:false,entityChanged:false,missingMeaning:[],addedMeaning:[],changedMeaning:[],reason:'完整保义且新ASR等价'};
 const h=harness({originalText:'用这招解决你',duration:n=>n<=3?12:8,rewriteText:(_input,n)=>n===1?'够':'用这招打倒你',semanticReview:i=>i.candidateBodyChinese==='够'?{...good,faithful:false,missingMeaning:['丢失动作与对象'],reason:'够是残缺意图'}:good});
 await h.api.executeAutoRun('run','TEST');assert.equal(h.calls.rewrites.length,2);assert.equal(h.calls.rewrites[1].repairMeaning,true);assert.match(h.calls.rewrites[1].semanticFeedback,/动作/);
 const selected=h.clips.get(h.finished[2]);assert.equal(h.finished[0],'passed');assert.equal(selected.spoken_text,'用这招打倒你');assert.equal(selected.review_state,'locked');
 assert.ok(h.calls.semanticRequests.some(i=>i.candidateBodyChinese==='够'));assert.ok(h.calls.native.filter(c=>c.spoken_text==='够').every(c=>c.review_state==='candidate'));
});
for(const stage of ['original','rewrite','cleanup'])for(const change of ['question','comma'])test(`final ${stage} candidate subtitle ${change} edit stops the run even with passing audio/semantics`,async()=>{
 const original=stage==='cleanup'?'嗯，你在做什么？':'你在做什么？';
 const h=harness({originalText:original,bodyText:'你在做什么？',cleanup:stage==='cleanup',duration:n=>stage==='rewrite'&&n<=3?12:stage==='cleanup'?7:8,rewriteText:'做什么？',finalSubtitleAtCommit:change==='question'?(stage==='rewrite'?'做什么':original.replace('？','')):(stage==='rewrite'?'做，什么？':original.replace('什么','什，么'))});
 await h.api.executeAutoRun('run','TEST');assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);assert.equal(h.calls.grouping.length,0);assert.match(h.finished[1],/字幕.*人工修改/);
 assert.ok([...h.clips.values()].every(c=>c.review_state!=='locked'));
});
test('replacing a verified body while assembly waits on its save transaction stops before any final artifact is registered',async()=>{
 const h=harness({cleanup:true,originalText:'嗯，完整的中文原稿',duration:7,replaceBodyAtAssemblyCommit:true});
 await h.api.executeAutoRun('run','TEST');assert.equal(h.finished[0],'failed');assert.equal(h.finished[2],null);assert.equal(h.calls.edits.length,0);assert.match(h.finished[1],/拼回保存前已变化/);
});

test('ordinary rewrite and independent meaning review both receive this line Japanese/English Chinese references',async()=>{
 const h=harness({originalText:'必须治疗才能继续战斗',textJp:'回復して 立て直す',textEn:'Heal up and regroup.',translateZhJp:'恢复状态，重新站起',translateZhEn:'恢复状态，重新集结。',duration:n=>n<=3?12:8,rewriteText:'恢复状态，重新战斗'});
 await h.api.executeAutoRun('run','TEST');
 assert.equal(h.finished[0],'passed');assert.equal(h.calls.rewrites.length,1);
 for(const i of [...h.calls.rewrites,...h.calls.semanticRequests]) {
  assert.equal(i.japaneseChineseTranslation,'恢复状态，重新站起');assert.equal(i.englishChineseTranslation,'恢复状态，重新集结。');
 }
 assert.ok(h.calls.semanticRequests.length>0);const selected=h.clips.get(h.finished[2]);assert.equal(selected.review_state,'locked');
 assert.equal(selected.spoken_text,'恢复状态，重新战斗');assert.equal(selected.game_zh_text_snapshot,'必须治疗才能继续战斗');
});

for(const changed of [false,true])test(`translation-based meaning approval ${changed?'stops when a human changes the reference before commit':'can lock without matching the original wording'}`,async()=>{
 const good={faithful:true,readingEquivalent:true,needsHuman:false,readingUncertain:false,hardReadingRisk:false,negationChanged:false,questionChanged:false,entityChanged:false,missingMeaning:[],addedMeaning:[],changedMeaning:[],meaningReference:'japanese-translation',reason:'成稿接近日译中的核心恢复意图'};
 const h=harness({originalText:'必须治疗才能继续战斗',translateZhJp:'恢复状态，重新站起',translateZhEn:'恢复状态，重新集结。',duration:n=>n<=3?12:8,rewriteText:'恢复状态，重新战斗',semanticReview:good,referenceChangedAtCommit:changed});
 await h.api.executeAutoRun('run','TEST');assert.equal(h.finished[0],changed?'failed':'passed');
 if(changed){assert.equal(h.finished[2],null);assert.ok([...h.clips.values()].every(c=>c.review_state!=='locked'));}
 else {const selected=h.clips.get(h.finished[2]);assert.equal(selected.review_state,'locked');assert.equal(selected.conversion_meta.semantic_review.meaningReference,'japanese-translation');}
});

test('ordinary natural-erhua recognition reaches final semantic fast gate and auto-locks the unchanged original',async()=>{
 const h=harness({originalText:'待会再说',duration:8,asrTextForClip:()=> '待会儿再说。',judgeResult:{ok:true,reason:'自然儿化等价',readingEquivalence:'natural-erhua-v1',pronunciationNotes:[],pronunciationIssueCount:0}});
 await h.api.executeAutoRun('run','TEST');assert.equal(h.finished[0],'passed');assert.equal(h.calls.semanticRequests.length,0);
 const c=h.clips.get(h.finished[2]);assert.equal(c.review_state,'locked');assert.equal(c.spoken_text,'待会再说');assert.equal(c.subtitle_text,null);assert.equal(c.conversion_meta.duration_review.asr,'待会儿再说。');
});
for(const changed of [false,true])test(`configured ASR name correction ${changed?'is invalidated if disabled before final lock':'passes both gates and preserves raw ASR and subtitles'}`,async()=>{
 const text='威吉会帮我们确保逃生路线畅通！',raw='危机会帮我们确保逃生路线畅通。';
 const h=harness({originalText:text,duration:8,asrTextForClip:()=>raw,asrWordRules:[{id:1,word:'威吉',aliases:['危机'],enabled:true,note:null}],rulesChangedAtCommit:changed,
  judgeResult:{ok:true,reason:'配置的ASR别名逐字对应',pronunciationNotes:[],pronunciationIssueCount:0}});
 await h.api.executeAutoRun('run','TEST');assert.equal(h.calls.semanticRequests.length,0);
 if(changed){assert.equal(h.finished[0],'failed');assert.match(h.finished[1],/ASR词语纠错规则/);assert.ok([...h.clips.values()].every(c=>c.review_state!=='locked'));}
 else {assert.equal(h.finished[0],'passed');const c=h.clips.get(h.finished[2]);assert.equal(c.review_state,'locked');assert.equal(c.spoken_text,text);assert.equal(c.subtitle_text,null);assert.equal(c.conversion_meta.duration_review.asr,raw);assert.equal(c.conversion_meta.semantic_review.asrWordCorrection.correctedText,'威吉会帮我们确保逃生路线畅通。');}
});
for(const forceGenerate of [false,true])test(`line-level skipped state stops startAutoRun even with forceGenerate=${forceGenerate}`,async()=>{
 const h=harness({processingState:'skipped'});
 const result=await h.api.startAutoRun('TEST',{forceGenerate});
 assert.equal(result.skipped,true);assert.match(result.reason,/跳过/);
 assert.equal(h.calls.tts.length,0);assert.equal(h.calls.asr.length,0);assert.equal(h.calls.rewrites.length,0);
 assert.ok(!h.calls.queries.some(q=>q.includes('INSERT INTO line_auto_runs')));
});
test('a queued task rechecks skipped state before any paid or GPU operation',async()=>{
 const h=harness({processingState:'skipped'});await h.api.executeAutoRun('run','TEST');
 assert.equal(h.finished[0],'failed');assert.match(h.finished[1],/跳过/);
 assert.equal(h.calls.tts.length,0);assert.equal(h.calls.asr.length,0);assert.equal(h.calls.rewrites.length,0);
});


test('anonymous ordinary audio retries three processed originals then rewrites without any neighboring context',async()=>{
 const h=harness({speaker:null,target:9,duration:call=>call<=3?12:8,rewriteText:'完整中文',semanticReview:()=>({faithful:true,readingEquivalent:true,needsHuman:false,readingUncertain:false,hardReadingRisk:false,negationChanged:false,questionChanged:false,entityChanged:false,missingMeaning:[],addedMeaning:[],changedMeaning:[],reason:'通过'})});
 await h.api.executeAutoRun('run','TEST');assert.equal(h.calls.tts.length,4);assert.equal(h.calls.rewrites.length,1);
 for(const input of h.calls.rewrites){assert.equal(Object.hasOwn(input,'before'),false);assert.equal(Object.hasOwn(input,'after'),false);}
 for(const input of h.calls.semanticRequests)assert.equal(input.context,null);
 assert.equal(h.calls.queries.some(q=>q.includes('l.id BETWEEN')),false);
 assert.equal(h.calls.tts[3].extra.candidateCount,3);assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
});
test('anonymous unchanged ordinary first pass can lock without a named actor or neighboring query',async()=>{
 const h=harness({speaker:null,duration:8});await h.api.executeAutoRun('run','TEST');assert.equal(h.calls.tts.length,1);assert.equal(h.calls.rewrites.length,0);assert.equal(h.calls.queries.some(q=>q.includes('l.id BETWEEN')),false);assert.equal(h.finished[0],'passed');assert.equal(h.clips.get(h.finished[2]).review_state,'locked');
});
test('ordinary total generation failure reports the actual generation error rather than a false timing result',async()=>{
 const h=harness({speaker:null,noAudio:true});await h.api.executeAutoRun('run','TEST');assert.equal(h.calls.tts.length,3);assert.equal(h.calls.rewrites.length,0);assert.equal(h.finished[0],'failed');assert.match(h.finished[1],/未生成可用音频.*TTS failed/);assert.ok([...h.clips.values()].every(c=>c.review_state!=='locked'));
});

test('anonymous ASR-translation baseline follows the same retry/rewrite pipeline without original Chinese or neighboring dialogue',async()=>{
 const h=harness({speaker:null,productionScript:{...translationSource(),originalChinese:null},duration:n=>n<=3?12:8,rewriteText:'自然短稿'});
 await h.api.executeAutoRun('run','TEST');assert.equal(h.finished[0],'passed');assert.equal(h.calls.tts.length,4);assert.equal(h.calls.tts[3].extra.candidateCount,3);
 const clip=h.clips.get(h.finished[2]);assert.equal(clip.review_state,'locked');assert.equal(clip.game_zh_text_snapshot,null);assert.equal(clip.spoken_text,'自然短稿');
 assert.equal(h.calls.rewrites[0].originalChinese,null);assert.equal(h.calls.rewrites[0].modelTranslatedChinese,translationSource().translation);
 assert.equal(h.calls.rewrites[0].checkOriginalMeaning,false);assert.equal(Object.hasOwn(h.calls.rewrites[0],'before'),false);assert.equal(Object.hasOwn(h.calls.rewrites[0],'after'),false);
 assert.equal(h.calls.queries.some(q=>q.includes('l.id BETWEEN')),false);
});
