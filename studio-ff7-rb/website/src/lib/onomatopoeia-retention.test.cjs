/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
function planner(reply, inspect) {
  const loaded = new Module(__filename);
  loaded.require = (id) => id === './auto-run-llm' ? {
    parseJsonObject: JSON.parse,
    rewriteChat: async (messages) => {
      inspect?.(messages);
      return { content: JSON.stringify({ original_jp_speech_text:'オトリか！',...reply }), thinking: '' };
    },
  } : require(`${id}.ts`);
  loaded._compile(ts.transpileModule(readFileSync(`${__dirname}/auto-run-onomatopoeia.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, `${__dirname}/auto-run-onomatopoeia.ts`);
  return loaded.exports.planOnomatopoeia;
}
const input = {
  textJp: 'おお オトリか！', textZh: '哦哦，诱饵吗！', ttsText: '哦！诱饵！', textEn: 'Oh! A decoy!', durationMs: 2600,
  jpAsr: { text:'おお オトリか！', words: [{ text: 'おお', start: 100, end: 600 }, { text: 'オトリか', start: 1000, end: 2400 }], utterances: [] },
};
test('BUC3700 original oh is retained even if the model incorrectly classifies it as ordinary speech', async () => {
  const plan = await planner({ speech_clause_indexes: [0,1], onomatopoeia_clause_indexes: [],
    cn_tts_text: '哦！诱饵！', reason: '都是正文' }, (messages) => {
    assert.deepEqual(JSON.parse(messages[1].content).required_original_indexes, [0]);
    assert.match(messages[0].content, /必须归入 onomatopoeia/);
  })(input);
  assert.equal(plan.enabled, true);
  assert.equal(plan.cnTtsText, '诱饵！');
  assert.equal(plan.jpSpeechText, 'オトリか！');
  assert.equal(plan.onomatopoeia.length, 1);
  assert.equal(plan.onomatopoeia[0].startMs, 0);
  assert.equal(plan.onomatopoeia[0].endMs, 1000);
});
test('model correctly omitting the original oh does not remove speech a second time', async () => {
  const plan = await planner({ speech_clause_indexes: [1], onomatopoeia_clause_indexes: [0], cn_tts_text: '诱饵！' })(input);
  assert.equal(plan.cnTtsText, '诱饵！');
  assert.equal(plan.speech.length, 1);
});

test('original oh caption survives a previously shortened revision without restoring deleted body words', async () => {
  const plan = await planner({ speech_clause_indexes: [1], onomatopoeia_clause_indexes: [0],
    cn_tts_text: '诱饵！', original_cn_tts_text: '诱饵！' })(input);
  const { restorePerformanceSubtitle } = require('./auto-run-subtitle.ts');
  assert.deepEqual(plan.subtitleRestore.preserved, [{ at: 0, text: '哦哦，' }]);
  assert.equal(restorePerformanceSubtitle(plan.subtitleRestore, plan.cnTtsText), '哦哦，诱饵！');
});
test('an already body-only revision still retains the original Japanese oh and its full original caption', async () => {
  const plan = await planner({ speech_clause_indexes: [0, 1], onomatopoeia_clause_indexes: [],
    cn_tts_text: '诱饵！' })({ ...input, ttsText: '诱饵！' });
  assert.equal(plan.onomatopoeia.length, 1);
  assert.equal(plan.cnTtsText, '诱饵！');
  assert.deepEqual(plan.subtitleRestore.preserved, [{ at: 0, text: '哦哦，' }]);
});
test('laughter restoration uses original caption independently of rewritten body', async () => {
  const plan = await planner({ speech_clause_indexes: [1], onomatopoeia_clause_indexes: [0],
    original_jp_speech_text: 'お宝で！', cn_tts_text: '我们发财啦！', original_cn_tts_text: '靠宝贝发家！' })({ ...input,
      textJp: 'いっししし お宝で！', textZh: '咿嘻嘻嘻，靠宝贝发家！', ttsText: '嘻，我们发财啦！',
      jpAsr: { text:'いっししし お宝で！', words: [{ text: 'いっししし', start: 100, end: 600 }, { text: 'お宝で', start: 1000, end: 2400 }], utterances: [] } });
  const { restorePerformanceSubtitle } = require('./auto-run-subtitle.ts');
  assert.equal(restorePerformanceSubtitle(plan.subtitleRestore, plan.cnTtsText), '咿嘻嘻嘻，我们发财啦！');
});

test('ASR words are the slicing target; official オレ and 食われ remain authoritative despite 俺/壊れ errors',async()=>{
 const official='オレ 食われたくない！';
 const plan=await planner({unparseable:false,speech_clause_indexes:[0,1],onomatopoeia_clause_indexes:[],
   cn_tts_text:'我不想被吃掉啊！',original_jp_speech_text:'俺 壊れたくない。'},messages=>{
   const data=JSON.parse(messages[1].content);assert.equal(data.slice_text_source,'seed-asr');assert.equal(data.text_jp,official);
   assert.deepEqual(data.subtitle_clauses.map(c=>c.text),['俺','壊れたくない']);
   assert.match(messages[0].content,/ASR 文字段/);assert.match(messages[0].content,/官方日文字幕/);
 })({textJp:official,textZh:'我不想被吃掉啊！',textEn:'',durationMs:2555,
   jpAsr:{text:'俺、壊れたくない。',utterances:[],words:[{text:'俺',start:120,end:360},{text:'壊れたくない',start:920,end:2040}]}});
 assert.equal(plan.enabled,false);assert.equal(plan.jpSpeechText,official);assert.equal(plan.cnTtsText,'我不想被吃掉啊！');assert.equal(plan.onomatopoeia.length,0);
});
test('ASR clause count can differ from official subtitle; reference Japanese stays official after FX deletion',async()=>{
 const body='魔晄を見つけた神羅みたいに オレらも大きくなる！';
 const plan=await planner({speech_clause_indexes:[1],onomatopoeia_clause_indexes:[0],
   cn_tts_text:'我们也要像神罗一样发迹！',original_cn_tts_text:'我们也要像神罗一样发迹！',original_jp_speech_text:body})(
 {textJp:'わあ！ '+body,textZh:'哇！我们也要像神罗一样发迹！',textEn:'',durationMs:4000,
 jpAsr:{text:'わあ、魔光を見つけた新羅みたいに俺らも大きくなる。',utterances:[],words:[{text:'わあ',start:100,end:600},{text:'魔光を見つけた新羅みたいに俺らも大きくなる',start:1000,end:3900}]}});
 assert.equal(plan.jpSpeechText,body);assert.equal(plan.onomatopoeia.length,1);assert.equal(plan.cnTtsText,'我们也要像神罗一样发迹！');
});
test('unparseable model result and copying ASR errors into official Japanese both trigger fallback errors',async()=>{
 const normal={...input,jpAsr:{...input.jpAsr,text:'おお オトリか！'}};
 await assert.rejects(()=>planner({unparseable:true,reason:'差异太大'})(normal),/无法解析/);
 await assert.rejects(()=>planner({speech_clause_indexes:[1],onomatopoeia_clause_indexes:[0],cn_tts_text:'诱饵！',original_jp_speech_text:'別の台詞'})(normal),/只允许删除/);
});
