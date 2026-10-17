// node --experimental-strip-types --test src/lib/tts-reference.test.cjs
/* eslint-disable @typescript-eslint/no-require-imports -- Node CJS runner loads the pure TS module with strip-types. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSpeechReference, mapReferenceSpeech, requireDeletionOnlyScript } = require('./tts-reference.ts');

function fixture(values, channels = 1) {
  const wav = Buffer.alloc(44 + values.length * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22); wav.writeUInt32LE(1000, 24);
  wav.writeUInt32LE(2000 * channels, 28); wav.writeUInt16LE(2 * channels, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(values.length * 2, 40);
  values.forEach((value, index) => wav.writeInt16LE(value, 44 + index * 2));
  return { wav, pcm: { sampleRate: 1000, blockAlign: channels * 2, dataOffset: 44, dataBytes: values.length * 2 } };
}
function build(values, onomatopoeia = [], ambient = []) {
  const { wav, pcm } = fixture(values);
  const result = buildSpeechReference(wav, pcm, { onomatopoeia, ambient });
  return { ...result, values: Array.from({ length: result.outputFrames }, (_,i) => result.audio.readInt16LE(44+i*2)) };
}

test('delete FX, trim outer silence, and retain internal original silence including low-level samples', () => {
  // A → laugh → B → phrase 1 → C → phrase 2 → D. Only C remains as silence.
  const input = [0,0, 8000,9000, 0,0, 2000,3000, 0,1,-1,0, 4000,5000, 0,0];
  const result = build(input, [{startMs:2,endMs:4}]);
  assert.deepEqual(result.values, [2000,3000,0,1,-1,0,4000,5000]);
  assert.equal(result.removedFrames, 2);
  assert.equal(result.trimmedLeadingFrames, 4);
  assert.equal(result.trimmedTrailingFrames, 2);
  assert.equal(result.audio.readUInt32LE(40), result.outputFrames * 2);
  assert.equal(result.audio.readUInt32LE(4), result.audio.length - 8);
});

test('internal environmental sound is deleted with no replacement silence or crossfade', () => {
  const result = build([1000,2000,0,0,9000,8000,0,1,0,3000,4000], [], [{startMs:4,endMs:6}]);
  assert.deepEqual(result.values, [1000,2000,0,0,0,1,0,3000,4000]);
  assert.equal(result.outputFrames, 9);
});

test('overlapping, unsorted FX cuts are removed once, on sample boundaries', () => {
  const result = build([1000,2000,3000,4000,5000,6000,7000], [{startMs:3,endMs:5},{startMs:1,endMs:4}], [{startMs:4,endMs:6}]);
  assert.deepEqual(result.values, [1000,7000]);
  assert.equal(result.removedFrames, 5);
});

test('no FX still trims only overall head/tail and preserves the middle pause', () => {
  assert.deepEqual(build([0,0,1000,2000,0,0,0,3000,0,0]).values, [1000,2000,0,0,0,3000]);
});

test('recognized leading silence with noise is trimmed before conservative edge detection', () => {
  const {wav,pcm} = fixture([9000,8000,20,25,20,1000,2000,0,1,0,3000,20,0]);
  const result = buildSpeechReference(wav,pcm,{
    onomatopoeia:[{startMs:0,endMs:2}],ambient:[],
    speech:[{startMs:5,endMs:11}],
  });
  assert.deepEqual(result.audio.subarray(44),wav.subarray(54,66));
  assert.equal(result.trimmedLeadingFrames,3);
  assert.equal(result.trimmedTrailingFrames,2);
});

test('unchanged PCM including positive peaks is copied exactly, never decoded/re-encoded', () => {
  const { wav, pcm } = fixture([32767,-32768,12345,-12345,1000]);
  const result = buildSpeechReference(wav, pcm, {onomatopoeia:[],ambient:[]});
  assert.deepEqual(result.audio, wav);
});

test('stereo channels remain byte-identical even with opposite phase', () => {
  const { wav, pcm } = fixture([0,0, 30000,-30000, 0,0, 10000,-10000, 0,0], 2);
  const result = buildSpeechReference(wav, pcm, {onomatopoeia:[],ambient:[]});
  assert.deepEqual(result.audio.subarray(44), wav.subarray(48,60));
  assert.equal(result.outputFrames, 3);
});

test('timeline mapping accounts for removed FX and trimmed leading silence', () => {
  const result = build([0,0,9000,8000,0,0,1000,2000,0,0,3000,4000,0,0], [{startMs:2,endMs:4}]);
  assert.deepEqual(mapReferenceSpeech([{startMs:6,endMs:8},{startMs:10,endMs:12}],result.kept,1000), [
    {startMs:0,endMs:2},{startMs:4,endMs:6},
  ]);
});

test('empty, silent or invalid reference preparation fails explicitly', () => {
  assert.throws(()=>build([1000,2000],[{startMs:0,endMs:2}]),/为空/);
  assert.throws(()=>build([0,0,0]),/正文声音/);
  assert.throws(()=>build([1000,2000],[{startMs:NaN,endMs:2}]),/区间无效/);
});

test('LLM may remove laugh and associated punctuation from the actual edited script', () => {
  assert.equal(requireDeletionOnlyScript('咿嘻嘻嘻\n咱们拿宝贝开公司啦！','咱们拿宝贝开公司啦！'),'咱们拿宝贝开公司啦！');
  assert.equal(requireDeletionOnlyScript('哦哦，诱饵吗！','哦哦，诱饵吗！'),'哦哦，诱饵吗！');
});

test('LLM cannot silently rewrite, restore an older script, or omit the cleaned text', () => {
  assert.throws(()=>requireDeletionOnlyScript('咱们拿宝贝开公司啦！','靠高价珍品开公司！'),/改写/);
  assert.throws(()=>requireDeletionOnlyScript('正文！',undefined),/没有返回/);
  assert.throws(()=>requireDeletionOnlyScript('正文！',''),/没有返回/);
});
