/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const stop = new Error('captured input before external TTS');
const original = '哦哦，诱饵吗！';
const manual = '已锁定的修改后中文，仅用于邻句参考';
const line = { stem:'test',text_zh:original,text_jp:'おお オトリか！',text_en:'A decoy!',jp_dur_s:2.6 };
function harness() {
  const calls = { queries:[], planner:[], clone:[] };
  const context = ['before','test','after'].map(stem=>({ ...line,stem,dialogue_mode:'scene',dialogue_evidence:{},subtitle_text:manual }));
  const sql = async (parts) => {
    const query=parts.join('?'); calls.queries.push(query);
    if(query.includes('SELECT tts_text, subtitle_text')) return [{tts_text:manual,subtitle_text:manual}];
    if(query.includes('SELECT l.stem, COALESCE')) return context;
    return [];
  };
  sql.json=value=>value;
  const mod = new Module(__filename);
  mod.require = id => {
    if(id==='node:fs/promises') return {readFile:async()=>Buffer.alloc(44)};
    if(id.startsWith('node:'))return require(id);
    if(id==='./db') return {sql};
    if(id==='./preserved-tail')return {locatePreservedTail:()=>null};
    if(id==='./inline-pinyin')return {stripInlinePinyin:x=>x};
    if(id==='./rewrite-context')return require('./rewrite-context.ts');
    if(id==='./auto-run-two-parts')return {setMeaningAnchor:()=>{}};
    if(id==='./fallback-feedback')return require('./fallback-feedback.ts');
    if(id==='./auto-run-rules')return require('./auto-run-rules.ts');
    if(id==='./missing-fragment')return{missingAudioBlocks:()=>[]};
    if(id==='./speech-segmentation')return {splitAsrClausesByOriginalPauses:input=>({clauses:input.clauses,splits:[]}),measurePerformanceSpeakingTime:()=>({speechSeconds:2.6}),alignJapaneseClauses:()=>[{startMs:0,endMs:2600,text:line.text_jp}]};
    if(id==='./auto-run-subtitle-format')return{createAutoRunSubtitleFormatter:()=>async x=>x};
    if(id==='./auto-run-subtitle')return require('./auto-run-subtitle.ts');
    if(id==='./tts-gpu')return {normalizeScript:x=>({ttsText:x}),wavTiming:()=>({start:0,end:2.6,speech:2.6,duration:2.6})};
    if(id==='./wav-stretch')return{decodeWavMono:()=>({sampleRate:1000,samples:new Float32Array(2600)})};
    if(id==='./audio-splice')return {audioToMonoWav:async b=>b};
    if(id==='./auto-run-onomatopoeia')return {planOnomatopoeia:async input=>{calls.planner.push(input);throw stop;}};
    if(id==='./rewrite-prompt')return {samePerformance:()=>true,takeUntilBoundary:(rows,index)=>({before:rows.slice(0,index),after:rows.slice(index+1)})};
    return {};
  };
  mod._compile(ts.transpileModule(readFileSync(`${__dirname}/auto-run.ts`,'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
  }).outputText + '\nexports.testHooks={runPerformance,runCasual,loadRewriteContext,setAsr:fn=>asrSeedFile=fn,setClone:fn=>generateClone=fn};', `${__dirname}/auto-run.ts`);
  const api=mod.exports.testHooks;
  api.setAsr(async()=>({result:{text:'おおとりか',words:[],utterances:[]},cached:true}));
  api.setClone(async(...args)=>{calls.clone.push(args);throw stop;});
  return {api,calls};
}
test('scene automation passes original Chinese to the model even if historical manual TTS exists', async()=>{
  const {api,calls}=harness();
  await assert.rejects(api.runPerformance('1',line,{candidates:[]}), e=>e===stop);
  assert.equal(calls.planner[0].ttsText,original);
  assert.equal(calls.planner[0].textZh,original);
  assert.ok(calls.queries.every(q=>!q.includes('FROM line_tts_versions')));
});
test('casual automation synthesizes original Chinese and does not inherit a manual subtitle', async()=>{
  const {api,calls}=harness();
  await assert.rejects(api.runCasual('1',line,{candidates:[]}),e=>e===stop);
  assert.equal(calls.clone[0][2],original);
  assert.deepEqual(calls.clone[0][3],{subtitleText:null});
  assert.ok(calls.queries.every(q=>!q.includes('FROM line_tts_versions')));
});
test('rewrite context uses locked neighboring Chinese while keeping current in-run draft separate', async()=>{
  const {api,calls}=harness();
  const previousFetch=global.fetch;
  global.fetch=async (_url,options)=>{
    assert.equal(JSON.parse(options.body).pairs[0].cn,'本轮自动改写');
    return {ok:true,json:async()=>({results:[{}]})};
  };
  try {
    const result=await api.loadRewriteContext('test','本轮自动改写','オトリか！');
    assert.equal(result.before[0].textZh,manual);
    assert.equal(result.before[0].originalTextZh,original);
    assert.equal(result.after[0].textZh,manual);
    assert.equal(result.before[0].lockedZh,manual);
    assert.equal(result.after[0].lockedZh,manual);
    assert.ok(calls.queries.some(q=>q.includes("review_state='locked'")));
    assert.equal(result.line.text_zh,original);
  } finally {global.fetch=previousFetch;}
});
