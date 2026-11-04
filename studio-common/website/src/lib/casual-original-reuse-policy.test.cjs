/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const m=new Module(__filename);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/casual-original-reuse-policy.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
const {planOriginalCandidateReuse:plan}=m.exports;
const line={stem:'ba_mako1_0030_0010_0000_cld_0',textZh:'不痛不痒',hasManualSelection:false,cleanupEnabled:false,currentTtsTextSent:'不痛不痒'};
const candidate={id:'6475',stem:line.stem,status:'ready',reviewState:'candidate',voiceGpuKey:'zeroshot-jp',audioPath:`tts/${line.stem}/6475.wav`,spokenText:'不痛不痒',subtitleText:null,gameZhSnapshot:'不痛不痒',ttsText:'不痛不痒',conversionMeta:{tts_text_sent:'不痛不痒',duration_review:{textPassed:true}}};
test('6475-style full original candidate is only a DSP candidate, never an inherited pass/lock',()=>{
 const result=plan(line,candidate);assert.equal(result.decision,'candidate-for-dsp');assert.equal(result.requiresSourceShaUnderLock,true);assert.equal(result.requiresFreshAsr,true);assert.equal(result.reusesOldAsr,false);assert.equal(result.consumesNativeTts,false);
 assert.deepEqual(candidate.conversionMeta,{tts_text_sent:'不痛不痒',duration_review:{textPassed:true}});assert.equal(candidate.reviewState,'candidate');
});
test('admission never depends on old ASR pass, model status, duration or group parent',()=>{
 for(const conversionMeta of [{tts_text_sent:'不痛不痒'},{tts_text_sent:'不痛不痒',duration_review:{textPassed:false}},{tts_text_sent:'不痛不痒',operation:'casual-speech-compression'}])assert.equal(plan(line,{...candidate,conversionMeta}).decision,'candidate-for-dsp');
});
test('changed script, stale snapshot, changed subtitle and NFKC lookalikes are not original reuse',()=>{
 for(const extra of [{spokenText:'毫无感觉'},{gameZhSnapshot:'旧原稿'},{gameZhSnapshot:null},{subtitleText:'人工改过的字幕'}])assert.equal(plan(line,{...candidate,...extra}).decision,'not-admitted');
 assert.equal(plan({...line,textZh:'编号Ａ'},{...candidate,spokenText:'编号A',gameZhSnapshot:'编号Ａ'}).decision,'not-admitted');
 assert.equal(plan(line,{...candidate,spokenText:'不痛，不痒！'}).decision,'candidate-for-dsp');
});
test('JP locks, other stems, missing audio, noncandidate state and unsafe paths never enter reuse',()=>{
 for(const extra of [{voiceGpuKey:'jp-lock'},{conversionMeta:{pipeline:'jp-lock'}},{stem:'other'},{audioPath:null},{audioPath:`tts/${line.stem}/../../other.wav`},{audioPath:'jp/original.mp3'},{status:'failed'},{reviewState:'locked'},{reviewState:'abnormal'}])assert.equal(plan(line,{...candidate,...extra}).decision,'not-admitted');
});
test('any existing human state blocks reuse, and cleanup body cannot pretend to be a complete original',()=>{
 assert.equal(plan({...line,hasManualSelection:true},candidate).decision,'not-admitted');
 assert.equal(plan({...line,textZh:''},candidate).decision,'not-admitted');
 assert.equal(plan({...line,cleanupEnabled:true},candidate).decision,'not-admitted');
 const full={...line,textZh:'嗯，不痛不痒'};assert.equal(plan(full,{...candidate,gameZhSnapshot:full.textZh}).decision,'not-admitted');
 assert.equal(plan({...line,cleanupEnabled:true},{...candidate,conversionMeta:{operation:'casual-original-edges-assembly'}}).decision,'not-admitted');
});

test('question marks in intended reading/subtitle and current final pronunciation payload are admission evidence',()=>{
 const q={...line,textZh:'入侵者？',currentTtsTextSent:'入侵者？'};
 for(const extra of [{spokenText:'入侵者',ttsText:'入侵者',subtitleText:null},{spokenText:'入侵者？',ttsText:'入侵者',subtitleText:null},{spokenText:'入侵者？',ttsText:'入侵者？',subtitleText:'入侵者'}])assert.equal(plan(q,{...candidate,gameZhSnapshot:q.textZh,conversionMeta:{tts_text_sent:'入侵者？'},...extra}).decision,'not-admitted');
 const l={...line,textZh:'陆号',currentTtsTextSent:'六号'};
 const old={...candidate,ttsText:'陆号',spokenText:'陆号',gameZhSnapshot:'陆号',conversionMeta:{tts_text_sent:'陆号'}};
 assert.equal(plan(l,old).decision,'not-admitted');assert.equal(plan(l,{...old,conversionMeta:{tts_text_sent:'六号'}}).decision,'candidate-for-dsp');
 assert.equal(plan({...l,currentFinalTtsText:'LIU4号'},{...old,conversionMeta:{tts_text_sent:'六号'}}).decision,'not-admitted');
 assert.equal(plan({...l,currentFinalTtsText:'LIU4号'},{...old,conversionMeta:{tts_text_sent:'六号',final_tts_payload_text:'LIU4号'}}).decision,'candidate-for-dsp');
});
