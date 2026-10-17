/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const { shortPerformancePolicy, checkShortCharacters, shortRewriteTarget, shortAudioDirection } = require('./auto-run-script-policy.ts');
const { compareWaveformSpans } = require('./auto-run-comparison.ts');
const loaded = new Module(__filename);
loaded.require = id => require(id.startsWith('./') ? `${id}.ts` : id);
loaded._compile(ts.transpileModule(readFileSync(`${__dirname}/tts-gpu.ts`, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, `${__dirname}/tts-gpu.ts`);
const { limitWavEdgeSilence, wavTiming } = loaded.exports;
const ratio = require('./beats.ts').NORMAL_JP_CN_RATIO;
function wav(samples, sampleRate = 1000) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v,i) => b.writeInt16LE(v,44+i*2)); return b;
}
test('short policy counts only cleaned Japanese body, counts non-quote punctuation for its cap, and excludes six-character lines', () => {
  const policy = shortPerformancePolicy('オトリか！', ratio);
  assert.deepEqual(policy, { jpCharacters: 4, min: 3, max: 5 });
  assert.equal(checkShortCharacters(policy, '诱饵！').pass, false);
  assert.equal(checkShortCharacters(policy, '诱饵吗！').pass, true);
  assert.equal(checkShortCharacters(policy, '原来是诱饵！').pass, true);
  assert.equal(checkShortCharacters(policy, '这原来是诱饵！').pass, false);
  assert.equal(checkShortCharacters(policy, '诱[停顿=300]饵吗！').characters, 3);
  assert.equal(shortPerformancePolicy('甲乙丙丁戊己', ratio), null);
  assert.equal(shortPerformancePolicy('？！', ratio), null);
  for (let n=1;n<6;n++) {
    const p=shortPerformancePolicy('あ'.repeat(n),ratio);
    assert.ok(p.min>=1 && p.min<=p.max && p.max===n);
  }
});
test('shorter or longer rewrite target responds to real duration feedback within character limits', () => {
  const p=shortPerformancePolicy('オトリか',ratio);
  assert.equal(shortRewriteTarget(p,'诱饵吗','longer'),4);
  assert.equal(shortRewriteTarget(p,'诱饵吗','shorter'),3);
  assert.equal(shortRewriteTarget(p,'诱饵','shorter'),3);
});
test('cap head and tail separately without touching internal silence, weak onset or body PCM', () => {
  const body=[100,10000,0,0,0,10000,100]; // 1% weak phonemes must survive
  const source=wav([0,0,0,0,...body,0,0,0,0,0]);
  const reference=wav([0,...body,0,0]);
  const result=limitWavEdgeSilence(source,reference);
  assert.deepEqual(result.audio.subarray(44),wav([0,...body,0,0]).subarray(44));
  assert.equal(result.meta.trimmedLeading,.003);
  assert.equal(result.meta.trimmedTrailing,.003);
  assert.ok(result.meta.after.start<=result.meta.leadingLimit);
  assert.ok(result.meta.after.duration-result.meta.after.end<=result.meta.trailingLimit+1e-9);
  assert.equal(result.audio.readUInt32LE(4),result.audio.length-8);
});
test('shorter existing edges are preserved and never padded to match Japanese silence', () => {
  const source=wav([0,9000,0]);
  assert.deepEqual(limitWavEdgeSilence(source,wav([0,0,9000,0,0])).audio,source);
  assert.throws(()=>limitWavEdgeSilence(wav([0,0]),source),/没有有效发声/);
});
test('long silence cannot make a 0.8s utterance pass a 1.6s Japanese reference', () => {
  const jp=wav([...Array(1600).fill(10000)]);
  const cn=wav([...Array(800).fill(10000),...Array(800).fill(0)]);
  const capped=limitWavEdgeSilence(cn,jp);
  const comparison=compareWaveformSpans(wavTiming(jp),wavTiming(capped.audio),{low:.85,high:1.15});
  assert.equal(comparison.spanRatio,.5);
  assert.equal(comparison.pass,false);
  assert.equal(wavTiming(capped.audio).duration,.8);
});
test('waveform duration gate includes endpoints and rejects missing or invalid speech', () => {
  for (const end of [.85,1.15]) assert.equal(compareWaveformSpans({start:0,end:1},{start:0,end},{low:.85,high:1.15}).pass,true);
  for (const end of [.849,1.151,0,NaN]) assert.equal(compareWaveformSpans({start:0,end:1},{start:0,end},{low:.85,high:1.15}).pass,false);
});

test('five short rewrites select by allowed character length even when an invalid two-character draft has a perfect beat ratio', async () => {
  const loadTs = name => {
    if(!name.startsWith('./'))return require(name);
    if(name==='./prompt-store')return require('./prompt-test-store.cjs');
 if(name==='./llm-metrics') return {beginLlmCall:async()=> 'test-log',recordLlmCall:async()=>{}};
    if(name==='./tts-gpu') return loaded.exports;
    if(name==='./auto-run-script-policy') return require('./auto-run-script-policy.ts');
    if(name==='./beats') return require('./beats.ts');
    if(name==='./spoken-text-review') return require('./spoken-text-review.ts');
    const mod=new Module(__filename);
    mod.require=loadTs;
    mod._compile(ts.transpileModule(readFileSync(`${__dirname}/${name.replace('./','')}.ts`,'utf8'), {
      compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
    }).outputText,`${__dirname}/${name}.ts`);
    return mod.exports;
  };
  const previousFetch=global.fetch;
  const previousUrl=process.env.REWRITE_LLM_URL, previousKey=process.env.REWRITE_LLM_KEY;
  let index=0;
  const texts=['诱饵！','诱饵吗！','是诱饵吗！','原来是诱饵吗！','诱饵吗！'];
  global.fetch=async (_url, options)=>{
    const prompt=JSON.parse(options.body).messages.map(m=>m.content).join('\n');
    assert.doesNotMatch(prompt,/正常范围是 0\.9|目标约/);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({text:texts[index++]})}}]}));
  };
  process.env.REWRITE_LLM_URL='http://test.invalid'; process.env.REWRITE_LLM_KEY='test';
  try {
    const measure=async text=>({jp:{units:null},cn:{units:[...text.replace(/\p{P}/gu,'')].length},normalizedRatio:text==='诱饵！'?1:9});
    const result=await loadTs('./auto-run-llm').rewriteFive({speaker:'',show:null,textJp:'オトリか！',textEn:'A decoy!',
      original:'诱饵吗！',current:'诱饵！',beats:await measure('诱饵！'),before:[],after:[],jpAsr:{raw:[]},failNotes:['中文发声偏短'],
      shortLine:{jpCharacters:4,min:3,max:4,target:3},measure});
    assert.equal(result.text,'诱饵吗！');
    assert.equal(result.pickedInBand,true);
    assert.equal(index,5);
  } finally {
    global.fetch=previousFetch;
    if(previousUrl===undefined) delete process.env.REWRITE_LLM_URL; else process.env.REWRITE_LLM_URL=previousUrl;
    if(previousKey===undefined) delete process.env.REWRITE_LLM_KEY; else process.env.REWRITE_LLM_KEY=previousKey;
  }
});

test('known short duration failure requires a longer draft even if ASR also failed', () => {
  const policy=shortPerformancePolicy('オトリか',ratio);
  assert.equal(shortAudioDirection([.634],.85,1.15),'longer');
  assert.equal(shortRewriteTarget(policy,'诱饵吗？',shortAudioDirection([.634],.85,1.15)),4);
  assert.equal(shortAudioDirection([1.3,1.4],.85,1.15),'shorter');
  for(const ratios of [[],[.8,1.2],[.9],[NaN]]) assert.equal(shortAudioDirection(ratios,.85,1.15),null);
});

const {performanceCharacterLimit}=require('./auto-run-script-policy.ts');
test('1600 cap is max(7 Japanese non-quote characters, floor(2.301 seconds times 3.5)) = 8, preserving full meaning',()=>{
 const limit=performanceCharacterLimit('さて 正解は～？',2.301);
 assert.deepEqual(limit,{jpLimitCharacters:7,durationLimit:8,speechSeconds:2.301,max:8});
 const p=shortPerformancePolicy('さて 正解は～？',ratio,2.301);assert.deepEqual(p,{jpCharacters:5,min:4,max:8});
 assert.equal(checkShortCharacters(p,'那么，正确答案是……？').characters,7);assert.equal(checkShortCharacters(p,'那么，正确答案是……？').pass,true);
 assert.equal(checkShortCharacters(p,'那么真正正确答案是？').pass,false);
});
test('Japanese punctuation counts once, quote styles and whitespace never consume cap, and unknown time never invents duration',()=>{
 for(const [a,b] of [['「','」'],['『','』'],['“','”'],['‘','’'],['"','"'],["'","'"],['｢','｣'],['＂','＂']])assert.equal(performanceCharacterLimit(`${a}さて${b} \n正解は～？`).max,7);
 assert.equal(performanceCharacterLimit('あ！',.57).max,2); // floor(1.995) is 1; Japanese 2 wins.
 assert.equal(performanceCharacterLimit('あ！',1).max,3);
 for(const seconds of [null,NaN,Infinity,0,-1])assert.equal(performanceCharacterLimit('あ！',seconds).max,2);
});
test('long internal silence cannot inflate the 3.5 characters per second allowance',()=>{
 const samples=new Float32Array(5000);samples.fill(.5,0,1000);samples.fill(.5,4000,5000);
 const measured=require('./speech-segmentation.ts').measurePerformanceSpeakingTime({samples,sampleRate:1000,startS:0,endS:5});
 assert.equal(measured.speechSeconds,2);assert.equal(performanceCharacterLimit('あ～',measured.speechSeconds).max,7);
});
