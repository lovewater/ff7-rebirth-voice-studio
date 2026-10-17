/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {localTtsAsr,needsChineseCutAxis}=require('./tts-local-asr.ts');
test('local ASR retains recognized text and waveform evidence without inventing character timestamps',()=>{
 const result=localTtsAsr('完整台词',{results:[{text:'完整台词'}]},{start:.1,end:3.1,duration:3.3});
 assert.equal(result.text,'完整台词');assert.equal(result.status,'local-qwen');assert.deepEqual(result.words,[]);assert.deepEqual(result.utterances,[]);
 assert.equal(result.raw.provider,'qwen-local');assert.equal(result.raw.waveform.startMs,100);assert.equal(result.raw.waveform.endMs,3100);
});
test('paid Chinese cut axis is only needed after selection when original sound must be inserted and Chinese has multiple clauses',()=>{
 assert.equal(needsChineseCutAxis('第一句，第二句！',[],[]),false);
 assert.equal(needsChineseCutAxis('整段正文！',[{}],[]),false);
 assert.equal(needsChineseCutAxis('第一句，第二句！',[{}],[]),true);
 assert.equal(needsChineseCutAxis('第一句\n第二句',[],[{}]),true);
});
