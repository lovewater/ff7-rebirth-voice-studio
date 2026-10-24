/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
function fixture({durations=[.5],textOk=true,beatPass=true}={}){
 const calls={tts:0,rewrite:0,finish:[],fallback:0,saves:[]},cache=new Map();let round=0;
 function load(name){if(!name.startsWith('.'))return require(name);if(name.endsWith('.json'))return require(path.resolve(__dirname,name));const f=path.resolve(__dirname,name+'.ts');if(cache.has(f))return cache.get(f).exports;const m=new Module(f);cache.set(f,m);m.require=load;m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);return m.exports;}
 const wav=load('./wav-stretch'),wave=seconds=>wav.encodeWavMono(1000,new Float32Array(Math.round(seconds*1000)).fill(.5)),jp=wave(2),beat={jp:{status:'ok',mora:30},cn:{han:4},normalizedRatio:beatPass?1:2};
 const sql=async()=>[];sql.json=x=>x;
 const overrides={
  './db':{sql},'./auto-run-part-alignment':{PartAssemblyError:class extends Error{}},'./llm-model-context':{currentChatModel:()=> 'primary'},'./auto-run-rules':{AUTO_RUN_MAX_ROUNDS:3},
  './italic-timing':load('./italic-timing'),'./audio-splice':{audioToMonoWav:async b=>b},'./wav-stretch':wav,
  './auto-run-script-policy':{spokenCharacters:t=>t.length,shortPerformancePolicy:()=>null,slowPerformancePolicy:()=>null,checkAutoBeat:()=>({enabled:true,pass:beatPass,ratio:beat.normalizedRatio,deviation:0})},
  './normal-speed-beat':{measureNormalSpeedBeatExemption:()=>({exempt:false})},'./speech-segmentation':{measurePerformanceSpeakingTime:()=>({speechSeconds:2})},
  './tts-gpu':{wavTiming:b=>({duration:wav.decodeWavMono(b).samples.length/1000,speech:1,start:0,end:1})},
  './tts-local-asr':{localTtsAsr:()=>({}),needsChineseCutAxis:()=>false},'./auto-run-llm':{judgeSpokenText:async()=>({ok:textOk,reason:'校字',missing:textOk?[]:['字'],extra:[],repeated:[],unrelated:[],pronunciationIssueCount:0}),rewriteChat:async()=>{calls.rewrite++;return {content:'{"text":"缩短正文"}'};}},
  './auto-run-subtitle-format':{createAutoRunSubtitleFormatter:()=>async t=>t},'./auto-run-onomatopoeia':{planSpliceAfterTts:async()=>({pieces:[{src:'tts',startMs:0,endMs:null}]})},
  'node:fs/promises':{mkdir:async()=>{},writeFile:async()=>{},readFile:async()=>wave(durations[Math.min(round-1,durations.length-1)])},
 };
 const m=new Module(__filename);m.require=id=>overrides[id]??(id.startsWith('./')?{}:require(id));
 const source=ts.transpileModule(fs.readFileSync(__dirname+'/auto-run.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 m._compile(source+`\nexports.run=runItalicNatural;exports.inject=d=>{log=async()=>{};lexicon=async()=>[];countBeats=d.beats;generateClone=d.generate;asrQwen=async()=>({text:'发现目标',raw:{}});saveSplicedEdit=d.save;finish=d.finish;finishWithFallback=d.fallback;loadDialogueContext=async()=>({before:[],after:[]});};`,__filename);
 m.exports.inject({beats:async()=>beat,generate:async()=>{calls.tts++;round++;return [{id:String(round),tts_text:'发现目标',spoken_text:'发现目标',audio_path:'tts/test.wav',dur_s:durations[Math.min(round-1,durations.length-1)]}];},save:async(...args)=>{calls.saves.push(args[7]);return 'edited-'+round;},finish:async(...args)=>calls.finish.push(args),fallback:async()=>calls.fallback++});
 const line={stem:'TEST',text_zh:'发现目标',text_jp:'目標を発見しました',subtitle_italic:true};const plan={enabled:false,cnTtsText:'发现目标',jpSpeechText:line.text_jp,onomatopoeia:[],ambient:[],speech:[{startMs:0,endMs:2000}]};
 return {calls,run:()=>m.exports.run('run',line,{candidates:[]},jp,plan,jp)};
}
test('short correct italic finishes after one batch, no duration rewrite or polish TTS',async()=>{const {calls,run}=fixture();await run();assert.equal(calls.tts,1);assert.equal(calls.rewrite,0);assert.equal(calls.finish[0][1],'passed');});
test('beat-only failure keeps edited candidate for review, disallows model fallback',async()=>{const {calls,run}=fixture({beatPass:false});await run();assert.equal(calls.tts,1);assert.equal(calls.rewrite,0);assert.equal(calls.finish[0][1],'failed');assert.equal(calls.finish[0][3],'edited-1');assert.equal(calls.finish[0][4].noModelRetry,true);});
test('real overlength retries with shorter text, then accepts shorter result',async()=>{const {calls,run}=fixture({durations:[3,.6]});await run();assert.equal(calls.tts,2);assert.equal(calls.rewrite,1);assert.equal(calls.finish[0][1],'passed');});
test('text failure reuses text, limited to three batches',async()=>{const {calls,run}=fixture({textOk:false});await run();assert.equal(calls.tts,3);assert.equal(calls.rewrite,0);assert.equal(calls.fallback,1);});
