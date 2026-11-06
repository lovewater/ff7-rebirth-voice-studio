/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),crypto=require('node:crypto');
function compile(file,deps={}){const m=new Module(file);m.require=id=>Object.hasOwn(deps,id)?deps[id]:id.startsWith('node:')?require(id):{};m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);return m.exports;}
const policy=compile(path.join(__dirname,'anonymous-tts-reference.ts'));
const japanese=Buffer.from('real own JP'),prompt=Buffer.from('own cleaned reference'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
test('anonymous clone binds real own JP and reference SHA without inventing an actor',()=>{
 const proof=policy.anonymousTtsReference({stem:'X',promptStem:'X',promptLang:'jp',promptPath:'jp/X.mp3',registeredReference:null,japanese,prompt:japanese});
 assert.equal(proof.stem,'X');assert.equal(proof.context,'none');assert.equal(proof.source_audio_sha256,sha(japanese));assert.equal(proof.reference_audio_sha256,sha(japanese));
});
test('anonymous cleaned reference must belong to the same persisted run and same line',()=>{
 const base={stem:'X',promptStem:'X',promptLang:'jp',promptPath:'tts/X/clean.wav',registeredReference:'tts/X/clean.wav',japanese,prompt};
 assert.equal(policy.anonymousTtsReference(base).reference_audio_sha256,sha(prompt));
 for(const change of [{registeredReference:null},{registeredReference:'tts/X/other.wav'},{promptStem:'NEIGHBOR'},{promptLang:'cn'},{promptPath:'tts/Y/clean.wav',registeredReference:'tts/Y/clean.wav'},{promptPath:'tts/X/../Y.wav',registeredReference:'tts/X/../Y.wav'},{expectedJapaneseSha256:'0'.repeat(64)},{japanese:Buffer.alloc(0)}])assert.throws(()=>policy.anonymousTtsReference({...base,...change}));
});
function routeHarness(options={}){
 const files=new Map([['jp/X.mp3',japanese],['cn/X.mp3',japanese],['tts/X/clean.wav',prompt],['tts/X/unregistered.wav',prompt]]),calls={gpu:[],inserted:[],saved:[],reads:[]};
 const line={stem:'X',speaker:options.speaker??null,text_jp:'スラムには帰れるの。',text_zh:'能回到贫民窟的。',dialogue_mode:'field',extra:{audio_sources:{jp:{clip:{mp3_sha256:options.sourceSha??sha(japanese)}}}}};
 const sql=async(parts,...values)=>{const q=parts.join('?');if(q.includes('SELECT l.stem'))return[line];if(q.includes('SELECT id,reference_audio_path'))return[{id:'42',reference_audio_path:options.registeredReference??null,stage_payload:{stage:1,model:'grok',allowGapSplit:false}}];if(q.includes('FROM pronunciations'))return[];if(q.includes('INSERT INTO line_tts_versions')){calls.inserted.push({q,values});return[{id:'9'}];}if(q.includes('UPDATE line_tts_versions')){calls.saved.push(values);return[];}throw Error('Unexpected SQL '+q);};sql.json=x=>x;
 const timing=()=>({start:0,end:1,duration:1,speech:1});
 const gap=compile(path.join(__dirname,'auto-run-gap-policy.ts'),{'./auto-run-rules':{isPerformanceMode:mode=>mode==='scene'||mode==='mixed'}});
 const deps={'next/server':{NextResponse:{json:(value,init)=>Response.json(value,init)}},'@/lib/db':{sql},'@/lib/anonymous-tts-reference':policy,
  '@/lib/line-processing-state':{isLineSkipped:()=>false},'@/lib/source-audio-policy':{audioReferenceIssue:()=>null},'@/lib/auto-run-gap-policy':gap,
  '@/lib/prompt-refs':{resolvePromptRef:async(s,current,ref)=>({ok:current===ref})},'@/lib/auto-run-subtitle':{autoRunSubtitle:x=>x},'@/lib/pronounce':{applyPronunciations:x=>x},
  '@/lib/tts-gpu':{TTS_URLS:['mock'],normalizeScript:x=>({ttsText:x,spokenText:x}),ensurePromptTailSilence:async b=>b,withTts:(_urls,fn)=>fn('mock'),matchPeak10Loudness:b=>b,wavTiming:timing,gpuJsonAt:async(_url,url,body)=>{calls.gpu.push({url,body});return url==='/health'?{}:{audio_wav_b64:Buffer.from('native audio').toString('base64'),conversion_meta:{}};}},
  '@/lib/wav-stretch':{wavAlignmentTiming:timing},'@/lib/auto-run-tts-budget':{reserveAutoTtsSlots:async()=>({count:1}),isAutoTtsBudgetError:()=>false},
  'node:fs/promises':{readFile:async p=>{const rel=p.slice((process.cwd()+'/data/').length);calls.reads.push(rel);if(!files.has(rel))throw Error('Missing fixture '+rel);return files.get(rel);},mkdir:async()=>{},writeFile:async(p,b)=>files.set(p,b)},
 };
 const route=compile(path.resolve(__dirname,'../app/api/lines/[stem]/tts/clone/route.ts'),deps);
 return{calls,post:async(body={})=>route.POST({json:async()=>({ttsText:'能回到贫民窟的。',autoRunId:'42',autoRunModel:'grok',autoRunStage:1,feedbackRound:true,candidateCount:1,...body})},{params:Promise.resolve({stem:'X'})})};
}
test('real clone endpoint accepts NULL speaker and saves source proof before the INSERT constraint',async()=>{
 const h=routeHarness(),r=await h.post();assert.equal(r.status,200);assert.equal(h.calls.gpu.filter(x=>x.url==='/v1/tts/clone').length,1);assert.equal(h.calls.inserted[0].values[2],null);
 const marker=h.calls.inserted[0].values.find(x=>x?.anonymous_single_line)?.anonymous_single_line;assert.equal(marker.context,'none');assert.equal(marker.source_audio_sha256,sha(japanese));
 assert.ok(h.calls.saved.some(values=>values.some(x=>x?.anonymous_single_line?.source_audio_sha256===sha(japanese))));
});
test('ordinary cleaned self reference reaches GPU while adjacent, CN, unregistered and changed sources cannot',async()=>{
 const h=routeHarness({registeredReference:'tts/X/clean.wav'});assert.equal((await h.post({promptPath:'tts/X/clean.wav',preservePromptAudio:true})).status,200);
 assert.equal(h.calls.gpu.find(x=>x.url==='/v1/tts/clone').body.prompt_audio,prompt.toString('base64'));
 for(const [options,body]of [[{}, {promptStem:'NEIGHBOR'}],[{}, {promptLang:'cn'}],[{}, {promptPath:'tts/X/unregistered.wav'}],[{sourceSha:'0'.repeat(64)},{}]]){
  const bad=routeHarness(options);assert.equal((await bad.post(body)).status,400);assert.equal(bad.calls.gpu.length,0);assert.equal(bad.calls.inserted.length,0);
 }
});
test('manual automatic-alignment edit preserves anonymous reference proof at insert and ready update',async()=>{
 const proof=policy.anonymousTtsReference({stem:'X',promptStem:'X',promptLang:'jp',promptPath:'jp/X.mp3',registeredReference:null,japanese,prompt:japanese}),saved=[];
 const sql=async(parts,...values)=>{const q=parts.join('?');if(q.includes('SELECT speaker'))return[{speaker:null,tts_text:'中文',spoken_text:'中文',subtitle_text:null,conversion_meta:{anonymous_single_line:proof}}];if(q.includes('INSERT INTO line_tts_versions')){assert.equal(values[1],null);assert.deepEqual(values.find(x=>x?.anonymous_single_line),{anonymous_single_line:proof});return[{id:'10'}];}if(q.includes('UPDATE line_tts_versions')){saved.push(values);return[];}throw Error(q);};sql.json=x=>x;
 const route=compile(path.resolve(__dirname,'../app/api/lines/[stem]/tts/[id]/edit/route.ts'),{'next/server':{NextResponse:{json:(v,i)=>Response.json(v,i)}},'@/lib/db':{sql},'@/lib/tts-gpu':{wavTiming:()=>({start:0,end:1,duration:1,speech:1})},'@/lib/auto-run-subtitle':{twoLineSubtitle:x=>x},'@/lib/speech-metrics-store':{measureSavedEdit:async()=>({})},'node:fs/promises':{mkdir:async()=>{},writeFile:async()=>{}}});
 const r=await route.POST({json:async()=>({wavBase64:Buffer.alloc(48).toString('base64')})},{params:Promise.resolve({stem:'X',id:'9'})});assert.equal(r.status,200);assert.ok(saved.some(values=>values.some(v=>v?.anonymous_single_line?.source_audio_sha256===sha(japanese))));
});
