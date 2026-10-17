/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
const { chineseSpliceClauses } = require('./speech-segmentation.ts');
// Load the real planner while disallowing LLM calls: splicing must stay deterministic.
const planner = new Module(__filename);
planner.require = (id) => id === './auto-run-llm' ? {
  rewriteChat() { throw new Error('splice must not call LLM'); },
} : require(`${id}.ts`);
planner._compile(ts.transpileModule(readFileSync(`${__dirname}/auto-run-onomatopoeia.ts`, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, `${__dirname}/auto-run-onomatopoeia.ts`);
const { planSpliceAfterTts } = planner.exports;
const sound = (n) => Array(n).fill(.5);
const quiet = (n) => Array(n).fill(0);
const word = (text, start, end) => ({ text, start, end });
const cut = (text, samples, words) => chineseSpliceClauses({ text, samples: Float32Array.from(samples), sampleRate: 1000, words });

// Reconciling JP/CN clause counts is deliberately absent from the cutting API.
test('BLT1900 Chinese whole clause stays whole despite a pause and different JP clause count', async () => {
  const cnAudio = { samples: Float32Array.from([...sound(900), ...quiet(400), ...sound(2090)]), sampleRate: 1000 };
  const result = await planSpliceAfterTts({ cnAudio, cnTtsText: '这些家伙在说什么啊',
    cnAsr: { words: [], utterances: [] }, onomatopoeia: [], ambient: [],
    speech: [{ startMs: 1900, endMs: 2900 }, { startMs: 2940, endMs: 3390 }] });
  assert.deepEqual(result.pieces, [{ src: 'tts', startMs: 0, endMs: null }]);
  assert.equal(result.cutMethod, 'whole-clause');
});
test('short valley corrects the CN ASR anchor without cutting weak speech onset', () => {
  const result = cut('第一句，第二句', [...sound(1885), ...quiet(25), ...sound(590)],
    [word('第一句', 120, 1520), word('第二句', 2000, 2400)]);
  assert.equal(result.adjustments[0].reason, 'energy-valley');
  assert.ok(result.clauses[0].endMs >= 1890 && result.clauses[0].endMs <= 1905);
  assert.equal(result.clauses[0].endMs, result.clauses[1].startMs);
});
test('a real long pause takes priority; cuts retain all samples including head and tail once', () => {
  const samples = Float32Array.from([...quiet(100), ...sound(900), ...quiet(500), ...sound(900), ...quiet(100)]);
  const result = cut('第一句 第二句', samples, [word('第一句', 120, 900), word('第二句', 1600, 2300)]);
  assert.equal(result.adjustments[0].reason, 'silence-interval');
  assert.equal(result.clauses[0].endMs, 1250);
  const rebuilt = result.clauses.flatMap((span) => [...samples.slice(span.startMs, span.endMs)]);
  assert.deepEqual(rebuilt, [...samples]);
});
test('no clear valley keeps the ASR anchor, with no guessed backward shift', () => {
  const result = cut('甲，乙', sound(2500), [word('甲', 0, 1000), word('乙', 1100, 2400)]);
  assert.equal(result.adjustments[0].reason, 'no-clear-valley');
  assert.equal(result.clauses[0].endMs, 1100);
});
test('text alignment rather than character counts tolerates an ASR insertion', () => {
  const result = cut('第一句，第二句', [...sound(1000), ...quiet(500), ...sound(1000)],
    [word('啊', 0, 30), word('第一句', 100, 900), word('第二句', 1600, 2400)]);
  assert.equal(result.method, 'asr-waveform');
  assert.equal(result.clauses[0].endMs, 1250);
});
test('no reliable ASR means whole audio, including when one timestamp spans both clauses', () => {
  for (const words of [[], [word('第一句第二句', 0, 2400)], [word('无关内容', 0, 2400)]]) {
    const result = cut('第一句，第二句', sound(2500), words);
    assert.equal(result.method, 'unreliable-alignment');
    assert.deepEqual(result.clauses, [{ startMs: 0, endMs: 2500, text: '第一句，第二句' }]);
  }
});
test('leading laugh stays before an intact Chinese clause even with two JP speech clauses', async () => {
  const result = await planSpliceAfterTts({
    cnAudio: { samples: Float32Array.from(sound(2500)), sampleRate: 1000 }, cnTtsText: '这些家伙在说什么啊',
    cnAsr: { words: [], utterances: [] },
    onomatopoeia: [{ startMs: 0, endMs: 800 }], ambient: [],
    speech: [{ startMs: 1900, endMs: 2900 }, { startMs: 2940, endMs: 3400 }],
  });
  assert.deepEqual(result.pieces, [{ src: 'ono', index: 0 }, { src: 'tts', startMs: 0, endMs: null }]);
});
