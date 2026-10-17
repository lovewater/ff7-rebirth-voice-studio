// node --experimental-strip-types --test src/lib/auto-run-comparison.test.cjs
/* eslint-disable @typescript-eslint/no-require-imports -- Node CJS runner loads pure TS comparison helpers. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {compareAudioSpans,recognizedSpeechSpan}=require('./auto-run-comparison.ts');
const {seedLangForPath,seedCacheMatches}=require('./seed-asr.ts');
const {subtitleSpeechText}=require('./speech-segmentation.ts');
const asr=(words=[],utterances=[])=>({words,utterances});
const word=(start,end,text='字')=>({start,end,text});
const rule={enabled:true,low:0.85,high:1.15};

test('compare against newly recognized prepared JP rather than the original laugh-containing timeline',()=>{
  const prepared=asr([word(50,1970)]);
  const candidate=asr([word(100,2020)]);
  const original=asr([word(100,1400,'笑'),word(2000,4800)]);
  assert.equal(compareAudioSpans(prepared,candidate,rule).spanRatio,1);
  assert.equal(compareAudioSpans(prepared,candidate,rule).pass,true);
  assert.equal(compareAudioSpans(original,candidate,rule).pass,false);
});

test('span direction is CN / JP and includes pauses between utterances',()=>{
  const result=compareAudioSpans(asr([word(0,300),word(800,1000)]),asr([word(0,500),word(900,1100)]),rule);
  assert.equal(result.jpSpan.span,1000);
  assert.equal(result.cnSpan.span,1100);
  assert.equal(result.spanRatio,1.1);
});

test('invalid word timestamps fall back to valid utterance timestamps',()=>{
  assert.deepEqual(recognizedSpeechSpan(asr([word(1,1),word(NaN,5)],[word(20,1020)])),{start:20,end:1020,span:1000});
});

test('missing timing remains null and cannot pass an enabled check',()=>{
  const result=compareAudioSpans(asr(),asr([word(0,1000)]),rule);
  assert.equal(result.spanRatio,null);
  assert.equal(result.pass,false);
});

test('short-line exemption keeps the measured ratio but records that the check was skipped',()=>{
  const result=compareAudioSpans(asr([word(0,1000)]),asr([word(0,500)]),{...rule,enabled:false});
  assert.equal(result.spanRatio,0.5);
  assert.equal(result.enabled,false);
  assert.equal(result.pass,true);
});

test('keep the existing inclusive span limits',()=>{
  for(const end of [850,1150])assert.equal(compareAudioSpans(asr([word(0,1000)]),asr([word(0,end)]),rule).pass,true);
  for(const end of [849,1151])assert.equal(compareAudioSpans(asr([word(0,1000)]),asr([word(0,end)]),rule).pass,false);
});

test('reference WAV in tts directory must use explicit Japanese language',()=>{
  assert.equal(seedLangForPath('tts/stem/auto-run-1-prompt.wav','ja-JP'),'ja-JP');
  assert.equal(seedLangForPath('tts/stem/123.wav'),'zh-CN');
  assert.equal(seedCacheMatches({sha256:'abc',language:'zh-CN'},'abc','ja-JP'),false);
  assert.equal(seedCacheMatches({sha256:'abc',language:'ja-JP'},'abc','ja-JP'),true);
  assert.equal(seedCacheMatches({sha256:'old',language:'ja-JP'},'new','ja-JP'),false);
});

test('clean Japanese text retains original punctuation used for beat calculations',()=>{
  assert.equal(subtitleSpeechText('フフフ\nネウチモンで、カンパニーだ～！',[1,2]),'ネウチモンで、カンパニーだ～！');
  assert.equal(subtitleSpeechText('第一句、\n第二句！',[0,1]),'第一句、\n第二句！');
  assert.equal(subtitleSpeechText('第一句、ハハハ！\n第二句。',[0,2]),'第一句、第二句。');
});
