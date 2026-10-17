/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),{readFileSync}=require('node:fs');
const Module=require('node:module'),ts=require('typescript');
const text='卖掉这个，我们就要发大财啦！';
const {RewriteDraftUnavailableError}=require('./auto-run-rewrite-retry.ts');
const timing={start:0,end:3.7,duration:3.752,speech:3.7};
const beat={jp:{status:'ok',units:18},cn:{units:13.5},normalizedRatio:1};
function scenario({withOriginal=false,waveLengths=null,unknownTail=false,noSpeech=false,speakingSeconds=3.752,chineseText=text,missingKind="onomatopoeia",missingError=false,jpSpeech=null,japaneseText=null,jpMora=null,normalizedRatio=1,emptySeed=null,fits=[true],textOk=true,lengths=[false,true],unreliable=false,planFails=false,asrFails=false,rewriteFailsAfter=null,maxRounds=2}={}){
 const calls={classifications:[],writes:[],queries:[],finish:[],rewrites:[],mix:0,saves:[],fallback:[],asr:0,localAsr:0,clone:[],plans:0,judges:0};
 const asr={text:emptySeed===null?text:emptySeed,words:[{text,start:0,end:3000}],utterances:[],raw:{}};
 const plan={enabled:false,reason:'无拟声',thinking:'',speech:[{startMs:0,endMs:3752}],onomatopoeia:[],ambient:[],cnTtsText:text,originalCnTtsText:text,jpSpeechText:japaneseText??'これを売ればオレたちは大金持ちだ！',subtitleRestore:{bodyCharacters:12,preserved:[]}};
 const sql=async(strings,...values)=>{calls.queries.push({query:strings.join('?'),values});return strings.join('').includes('INSERT INTO line_tts_versions')?[{id:'original-1'}]:[];};sql.json=x=>x;
 const m=new Module(__filename);
 m.require=id=>{
  if(id==='node:fs/promises')return{readFile:async file=>{const b=Buffer.alloc(44);Object.defineProperty(b,"testPath",{value:file});return b;},mkdir:async()=>{},writeFile:async(p,b)=>{calls.writes.push({path:p,bytes:b});}};
  if(id.startsWith('node:'))return require(id);
  if(id==='./db')return{sql};
  if(id==='./tts-local-asr')return require('./tts-local-asr.ts');
  if(id==='./qwen-asr')return{qwenAsr:async()=>{calls.localAsr++;return{text,raw:{text}};}};
  if(id==='./missing-jp-subtitle')return{classifyMissingJapaneseSubtitle:async(...args)=>{calls.classifications.push(args);if(missingError)throw Error('分类服务失败');return{kind:missingKind,reason:'中文分类测试'};}};
  if(id==='./missing-fragment')return{missingAudioBlocks:()=>[]};
  if(id==='./auto-run-rewrite-retry')return require('./auto-run-rewrite-retry.ts');
  if(id==='./auto-run-rules')return{...require('./auto-run-rules.ts'),AUTO_RUN_MAX_ROUNDS:maxRounds};
  if(id==='./fallback-feedback')return require('./fallback-feedback.ts');
  if(id==='./auto-run-fallback')return require('./auto-run-fallback.ts');
  if(id==='./auto-run-script-policy')return require('./auto-run-script-policy.ts');
  if(id==='./auto-run-subtitle')return require('./auto-run-subtitle.ts');
  if(id==='./auto-run-subtitle-format')return{createAutoRunSubtitleFormatter:()=>async x=>x};
  if(id==='./auto-run-comparison')return require('./auto-run-comparison.ts');
  if(id==='./audio-splice')return{audioToMonoWav:async b=>b,spliceMix:()=>{const ok=fits[Math.min(calls.mix++,fits.length-1)];return{ok,audio:Buffer.alloc(44),fit:{step:'speech',actual_s:ok?3.7:3.4,target:3.752}};}};
  if(id==='./auto-run-onomatopoeia')return{planOnomatopoeia:async()=>{calls.plans++;if(planFails)throw Error("分类结果不可用");return plan;},planSpliceAfterTts:async()=>({pieces:[{src:'tts',startMs:0,endMs:null}],reason:'最终校正',clauses:[text],boundaries:[],cutMethod:'whole-clause'})};
  if(id==='./speech-segmentation')return{alignJapaneseClauses:()=>unreliable?[]:[{startMs:0,endMs:3752,text:plan.jpSpeechText}],refinePerformanceBoundaries:()=>({onomatopoeia:[],clauses:[],adjustments:[]}),measurePerformanceSpeakingTime:()=>({speechSeconds:speakingSeconds,pauses:[],pauseSeconds:3.752-speakingSeconds}),segmentPerformanceAudio:()=>noSpeech?[]:[...(withOriginal?[{kind:'onomatopoeia',startMs:0,endMs:150}]:[]),{kind:'speech',startMs:0,endMs:3752},...(unknownTail?[{kind:'unknown',startMs:3752,endMs:3776}]:[])]};
  if(id==='./tts-reference')return{buildSpeechReference:()=>({audio:Buffer.alloc(44),kept:[{sourceStart:0,sourceEnd:90048}],sourceFrames:90048,outputFrames:90048})};
  if(id==='./tts-gpu')return{parseWavPcm16:()=>({sampleRate:24000}),wavTiming:b=>b.testPath?.endsWith('test.wav')&&waveLengths?{...timing,end:waveLengths[Math.min(round-1,waveLengths.length-1)],speech:waveLengths[Math.min(round-1,waveLengths.length-1)]}:timing,normalizeScript:x=>({ttsText:x})};
  if(id==='./wav-stretch')return{decodeWavMono:()=>({sampleRate:1000,samples:new Float32Array(3752)})};
  if(id==='./auto-run-llm')return{rewriteChat:async()=>({content:JSON.stringify({text,reason:'反馈测试'})}),parseJsonObject:JSON.parse,judgeSpokenText:async()=>{calls.judges++;return({ok:textOk,missing:textOk?[]:['要'],extra:[],repeated:[],unrelated:[],pronunciationNotes:[],pronunciationIssueCount:0});},rewriteFive:async input=>{calls.rewrites.push(input);if(rewriteFailsAfter!==null&&calls.rewrites.length>rewriteFailsAfter)throw new RewriteDraftUnavailableError(1,4,'无可用台词');return{text:rewriteFailsAfter===null?text:'这是本轮已经改过的台词！'};},showEvidenceLabel:()=>''};
  if(id==='./spoken-text-review')return{shouldRetrySameScript:n=>n===0};
  return{};
 };
 m._compile(ts.transpileModule(readFileSync(`${__dirname}/auto-run.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText+`
 exports.setup=(hooks)=>{lexicon=async()=>[];log=async()=>{};asrSeedFile=hooks.asr;generateClone=hooks.clone;countBeats=async()=>hooks.beat;saveAutoRunComparison=async()=>{};pickPassedClip=async(_id,_line,_asr,rows)=>rows[0];saveSplicedEdit=hooks.save;finish=hooks.finish;finishWithFallback=hooks.fallback;loadRewriteContext=async()=>({line:{},beats:hooks.beat,before:[],after:[]});};exports.runPerformance=runPerformance;
 `,`${__dirname}/auto-run.ts`);
 let round=0;
 const recovery={candidates:[]};
 m.exports.setup({beat:{...beat,jpSpeech,normalizedRatio,jp:{...beat.jp,mora:jpMora}},asr:async()=>{calls.asr++;if(asrFails)throw Error("ASR timeout");return{result:asr,stored:{sha256:'test',path:'test.wav'}};},clone:async(_run,_stem,_text,options)=>{calls.clone.push({...options,script:_text});round++;return Array.from({length:options.manualTemplates&&!options.feedbackRound?3:1},(_,i)=>({id:String(round+i),audio_path:'test.wav',tts_text:_text,spoken_text:_text,dur_s:3.2,speech_pass:lengths[Math.min(round-1,lengths.length-1)]}));},save:async(_run,_stem,source)=>{const id='edit-'+source;calls.saves.push(id);return id;},finish:async(...args)=>calls.finish.push(args),fallback:async(run,recovery)=>{calls.fallback.push(await recovery.assemble(recovery.candidates[0]));}});
 return{calls,recovery,run:()=>m.exports.runPerformance('run',{stem:'test',text_zh:chineseText,text_jp:plan.jpSpeechText,jp_dur_s:3.752},recovery)};
}
test('candidate duration failure retries before selection, then edits only the selected audio once',async()=>{
 const s=scenario();await s.run();
 assert.equal(s.calls.mix,1);
 assert.equal(s.calls.rewrites.length,1);
 assert.match(s.calls.rewrites[0].extraUser,/偏短.*增加汉字/);
 assert.deepEqual(s.calls.finish,[['run','passed',null,'edit-2']]);
 assert.deepEqual(s.calls.saves,['edit-2']);
});
test('final edit residual never triggers another TTS round or changes the selected candidate',async()=>{
 const s=scenario({fits:[false],lengths:[true]});await s.run();
 assert.equal(s.calls.mix,1);
 assert.equal(s.calls.rewrites.length,0);
 assert.deepEqual(s.calls.finish,[['run','passed',null,'edit-1']]);
 assert.equal(s.calls.fallback.length,0);
});
test('exhausted duration checks still edit the best fallback once',async()=>{
 const s=scenario({fits:[false],lengths:[false]});await s.run();
 assert.equal(s.calls.mix,1);
 assert.equal(s.calls.finish.length,0);
 assert.deepEqual(s.calls.fallback,['edit-1']);
});
test('no-FX fallback still gets bounded final fitting when every ASR review fails',async()=>{
 const s=scenario({textOk:false,fits:[false]});await s.run();
 assert.equal(s.calls.mix,1);
 assert.deepEqual(s.calls.fallback,['edit-1']);
 assert.equal(s.calls.finish.length,0);
});

test('unreliable Japanese ASR uses the separate whole-line route with three candidates and a final edited audio, skipping automatic judgement',async()=>{
 const s=scenario({unreliable:true});await s.run();
 assert.equal(s.calls.asr,1);assert.equal(s.calls.plans,0);assert.equal(s.calls.judges,0);
 assert.equal(s.calls.clone.length,3);assert.equal(s.calls.clone[0].feedbackRound,true);
 assert.equal(s.calls.clone[0].promptPath,'jp/test.mp3');
 assert.equal(s.recovery.candidates.length,3);assert.equal(s.calls.mix,1);assert.equal(s.calls.rewrites.length,0);
 assert.equal(s.calls.finish[0][1],'failed');assert.equal(s.calls.finish[0][3],'edit-1');
 assert.match(s.calls.finish[0][2],/整句降级线路已产生成品.*未经自动评判.*待人工复核/);
});
test('unusable LLM classification also uses whole-line fallback and still edits a final audio without further model or Chinese ASR calls',async()=>{
 const s=scenario({planFails:true});await s.run();
 assert.equal(s.calls.asr,1);assert.equal(s.calls.plans,1);assert.equal(s.calls.judges,0);
 assert.equal(s.recovery.candidates.length,3);assert.equal(s.calls.mix,1);assert.equal(s.calls.rewrites.length,0);
 assert.match(s.calls.finish[0][2],/分类不可用.*已产生成品/);
});

test('Japanese ASR service failure also reaches a playable whole-line final output',async()=>{
 const s=scenario({asrFails:true});await s.run();
 assert.equal(s.calls.asr,1);assert.equal(s.calls.plans,0);assert.equal(s.calls.judges,0);
 assert.equal(s.recovery.candidates.length,3);assert.equal(s.calls.mix,1);
 assert.equal(s.calls.finish[0][3],'edit-1');assert.match(s.calls.finish[0][2],/Seed-ASR 不可用.*已产生成品/);
});

test('exhausted rewrite retries enter a separate current-script route: three fresh candidates, then one final edit',async()=>{
 const s=scenario({rewriteFailsAfter:0});await s.run();
 assert.equal(s.calls.clone.length,4);assert.equal(s.calls.clone[1].feedbackRound,true);assert.equal(s.calls.clone[1].script,text);
 assert.equal(s.calls.asr,2);assert.equal(s.calls.localAsr,1);assert.equal(s.calls.judges,1);assert.equal(s.calls.mix,1);assert.equal(s.calls.rewrites.length,1);
 assert.equal(s.recovery.candidates.length,4);assert.equal(s.calls.finish[0][3],'edit-2');assert.match(s.calls.finish[0][2],/当前稿反馈改稿 TTS 线路已产生成品/);
});
test('current-script fallback keeps the last successful in-run rewrite rather than reverting to the original script',async()=>{
 const s=scenario({rewriteFailsAfter:1,maxRounds:3,lengths:[false]});await s.run();
 assert.equal(s.calls.clone.length,5);assert.equal(s.calls.clone[2].feedbackRound,true);
 assert.equal(s.calls.clone[2].script,'这是本轮已经改过的台词！');assert.equal(s.calls.clone[2].subtitleText,'这是本轮已经改过的台词！');
 assert.equal(s.calls.asr,2);assert.equal(s.calls.localAsr,2);assert.equal(s.calls.judges,2);assert.equal(s.calls.mix,1);assert.equal(s.calls.rewrites.length,2);
 assert.equal(s.recovery.candidates.length,5);assert.equal(s.calls.finish[0][3],'edit-3');
});

for(const emptySeed of ['', '  \n '])test('empty Japanese Seed directly preserves original audio and Chinese subtitle without TTS or classification: '+JSON.stringify(emptySeed),async()=>{
 const s=scenario({emptySeed});await s.run();
 assert.equal(s.calls.asr,1);assert.equal(s.calls.plans,0);assert.equal(s.calls.judges,0);
 assert.equal(s.calls.clone.length,0);assert.equal(s.calls.mix,0);assert.equal(s.calls.rewrites.length,0);
 assert.equal(s.recovery.candidates.length,0);assert.equal(s.calls.writes.length,1);
 assert.match(s.calls.writes[0].path,/tts\/test\/original-1\.mp3$/);
 assert.deepEqual(s.calls.writes[0].bytes,Buffer.alloc(44));
 const insert=s.calls.queries.find(q=>q.query.includes('INSERT INTO line_tts_versions'));
 assert.ok(insert.values.includes(text));assert.ok(insert.values.includes('jp-lock'));
 const update=s.calls.queries.find(q=>q.query.includes('UPDATE line_tts_versions'));
 assert.equal(update.values.find(v=>v?.workflow)?.workflow,'seed-empty-original');
 assert.doesNotMatch(update.query,/review_state\s*=/);
 assert.deepEqual(s.calls.finish,[['run','passed',null,'original-1',{preserveSubtitle:true}]]);
});

test('long slow Japanese can pass despite extreme beats; regular-speed Japanese cannot use that exemption',async()=>{
 const slow=scenario({jpMora:10,normalizedRatio:3,lengths:[true]});await slow.run();
 assert.equal(slow.calls.finish[0][1],'passed');assert.equal(slow.calls.rewrites.length,0);
 const ordinary=scenario({jpMora:12,normalizedRatio:3,lengths:[true]});await ordinary.run();
 assert.equal(ordinary.calls.finish.length,0);assert.equal(ordinary.calls.rewrites.length,1);assert.equal(ordinary.calls.fallback.length,1);
});
test('slow exemption still requires pre-edit duration and supplies the mora target to the model when retrying',async()=>{
 const s=scenario({jpMora:10,normalizedRatio:3,lengths:[false,true]});await s.run();
 assert.equal(s.calls.clone.length,2);assert.equal(s.calls.rewrites.length,1);
 assert.equal(s.calls.rewrites[0].slowLine.target,10);
 assert.match(s.calls.rewrites[0].extraUser,/接近或等于 10 字/);
 assert.equal(s.calls.finish[0][1],'passed');assert.equal(s.calls.mix,1);
});

test('a line both short and slow uses the mora target without the old Japanese character cap',async()=>{
 const s=scenario({japaneseText:'オトリか',jpSpeech:{status:'ok',mora:4,reading:'おとりか'},lengths:[false,true]});await s.run();
 assert.equal(s.calls.rewrites[0].slowLine.target,4);
 assert.equal(s.calls.finish[0][1],'passed');
});

test('missing official Japanese with all-FX Chinese and Japanese reaction keeps exact JP original',async()=>{
 const s=scenario({japaneseText:'',chineseText:'唔嗝！',emptySeed:'うっぷ。'});await s.run();
 assert.deepEqual(s.calls.classifications,[['唔嗝！','うっぷ。']]);assert.equal(s.calls.clone.length,0);assert.equal(s.calls.asr,1);assert.equal(s.calls.mix,0);assert.equal(s.calls.plans,0);
 assert.equal(s.calls.finish[0][1],'passed');assert.deepEqual(s.calls.finish[0][4],{preserveSubtitle:true});
 const saved=s.calls.queries.find(q=>q.query.includes('conversion_meta'));
 assert.ok(saved.values.some(v=>v?.workflow==='missing-jp-subtitle-original'));
 const insert=s.calls.queries.find(q=>q.query.includes('INSERT INTO line_tts_versions'));assert.ok(insert.values.includes('唔嗝！'));assert.ok(insert.values.includes('うっぷ。'));
 assert.equal(s.calls.writes.length,1);assert.ok(s.calls.queries.every(q=>!q.query.includes('UPDATE lines')));
});
test('missing official Japanese and empty Seed must classify Chinese before choosing original audio',async()=>{
 const s=scenario({japaneseText:'',chineseText:'唔嗝！',emptySeed:''});await s.run();
 assert.deepEqual(s.calls.classifications,[['唔嗝！','']]);assert.equal(s.calls.clone.length,0);assert.equal(s.calls.finish[0][1],'passed');
});
test('missing Japanese with ordinary/mixed/unknown Chinese or classifier failure always takes three-template fallback, including empty Seed',async()=>{
 for(const extra of [{missingKind:'speech'},{missingKind:'unknown'},{missingError:true}]){
  const s=scenario({japaneseText:'',emptySeed:'',...extra});await s.run();
  assert.equal(s.calls.classifications.length,1);assert.equal(s.calls.clone.length,3);assert.equal(s.calls.clone[0].feedbackRound,true);
  assert.equal(s.recovery.candidates.length,3);assert.equal(s.calls.mix,1);assert.equal(s.calls.finish[0][1],'failed');assert.equal(s.calls.finish[0][3],'edit-1');assert.equal(s.calls.judges,0);
 }
});
test('missing official Japanese can still classify Chinese if Seed service fails; ordinary existing-subtitle error route is unchanged',async()=>{
 const s=scenario({japaneseText:'',chineseText:'唔嗝！',asrFails:true});await s.run();
 assert.deepEqual(s.calls.classifications,[['唔嗝！','']]);assert.equal(s.calls.clone.length,0);assert.equal(s.calls.finish[0][1],'passed');
 const normal=scenario({asrFails:true});await normal.run();assert.equal(normal.calls.classifications.length,0);assert.equal(normal.recovery.candidates.length,3);
});

test('2600 Chinese reaction does not authorize keeping Japanese ordinary speech 行こう; three-template fallback is required',async()=>{
 const s=scenario({japaneseText:'',chineseText:'唔嗝！',emptySeed:'行こう。',missingKind:'speech'});await s.run();
 assert.deepEqual(s.calls.classifications,[['唔嗝！','行こう。']]);assert.equal(s.calls.clone.length,3);assert.equal(s.calls.clone[0].feedbackRound,true);assert.equal(s.recovery.candidates.length,3);assert.equal(s.calls.finish[0][1],'failed');assert.equal(s.calls.finish[0][3],'edit-1');
});

test('workflow gives model the duration-based short cap from net speaking time, not file or speech-span duration',async()=>{
 const s=scenario({japaneseText:'さて 正解は～？',speakingSeconds:2.301});await s.run();
 assert.equal(s.calls.rewrites[0].shortLine.max,8);assert.match(s.calls.rewrites[0].extraUser,/净发声2.301秒/);assert.match(s.calls.rewrites[0].extraUser,/中文标点、空白不计字数/);
});
test('slow exemption also enforces the new upper cap instead of silently accepting unlimited Chinese characters',async()=>{
 const s=scenario({japaneseText:'オトリか',speakingSeconds:2.301,jpSpeech:{status:'ok',mora:4,reading:'おとりか'},lengths:[true]});await s.run();
 assert.equal(s.calls.rewrites[0].slowLine.max,8);assert.ok(s.recovery.candidates[0].characterDeviation>0);assert.equal(s.calls.fallback.length,1);assert.equal(s.calls.finish.length,0);
});

for(const extra of [{unknownTail:true},{noSpeech:true}])test('unresolved segmentation still produces three whole-line feedback candidates and a final audio: '+JSON.stringify(extra),async()=>{
 const s=scenario(extra);await s.run();assert.equal(s.calls.clone.length,3);assert.ok(s.calls.clone.every(c=>c.feedbackRound));assert.equal(s.calls.asr,1);assert.equal(s.calls.judges,0);assert.equal(s.calls.finish[0][1],'failed');assert.equal(s.calls.finish[0][3],'edit-1');assert.equal(s.recovery.candidates.length,3);
});

test('ordinary correct speech that is clearly short switches later rewriting and acceptance to duration instead of beats',async()=>{
 const s=scenario({waveLengths:[2.8,3.7],normalizedRatio:.728,lengths:[false,true]});await s.run();
 assert.equal(s.calls.rewrites.length,1);assert.ok(s.calls.rewrites[0].durationLine);assert.match(s.calls.rewrites[0].extraUser,/比只作参考/);
 assert.equal(s.calls.finish[0][1],'passed');assert.equal(s.calls.finish[0][3],'edit-2');assert.ok(s.recovery.candidates.every(c=>c.beatDeviation===0));
});
test('duration exemption persists after overshoot, updates advisory characters downward, and does not add TTS rounds',async()=>{
 const s=scenario({waveLengths:[2.8,4.5,3.7],normalizedRatio:.728,lengths:[false,false,true],maxRounds:3});await s.run();
 assert.equal(s.calls.clone.length,3);assert.equal(s.calls.rewrites.length,2);assert.ok(s.calls.rewrites[1].durationLine.target<s.calls.rewrites[1].durationLine.currentCharacters);assert.equal(s.calls.finish[0][1],'passed');assert.ok(s.recovery.candidates.every(c=>c.beatDeviation===0));
});
test('missing words alone cannot trigger the duration exemption or speculative expansion of the script',async()=>{
 const s=scenario({waveLengths:[2.8],textOk:false,normalizedRatio:1,lengths:[false]});await s.run();assert.equal(s.calls.rewrites.length,0);assert.equal(s.calls.clone.length,2);assert.equal(s.calls.fallback.length,1);
});

// 无拟声的中文候选只做本地校字；Seed调用固定是日文原声+实际参考各一次。
test('normal multi-round Chinese review uses local ASR and never charges Seed per candidate',async()=>{
 const s=scenario({lengths:[false,true]});await s.run();
 assert.equal(s.calls.clone.length,2);assert.equal(s.calls.localAsr,2);assert.equal(s.calls.asr,2);
 assert.ok(s.recovery.candidates.every(row=>row.asr.status==='local-qwen'&&row.asr.words.length===0));
});

test('only chosen multi-clause original-sound splice requests Chinese Seed axis once',async()=>{
 const s=scenario({withOriginal:true,lengths:[false,true]});await s.run();
 assert.equal(s.calls.localAsr,2);assert.equal(s.calls.asr,3);
 assert.equal(s.calls.finish[0][3],'edit-2');
 const selected=s.recovery.candidates.find(row=>row.clip.id==='2');
 assert.equal(selected.cutAxisRequested,true);assert.ok(selected.asr.words.length>0);
 await s.recovery.assemble(selected);assert.equal(s.calls.asr,3);
});
