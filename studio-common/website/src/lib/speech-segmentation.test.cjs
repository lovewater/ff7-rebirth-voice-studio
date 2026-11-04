// Run with: node --experimental-strip-types --test src/lib/speech-segmentation.test.cjs
/* eslint-disable @typescript-eslint/no-require-imports -- Node's CJS test runner loads the pure TS module with strip-types. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { alignJapaneseClauses, refinePerformanceBoundaries, segmentPerformanceAudio } = require('./speech-segmentation.ts');

function segment(samples, extra = {}) {
  return segmentPerformanceAudio({
    samples: Float32Array.from(samples), sampleRate: 1000,
    speech: [], words: [], onomatopoeia: [], ...extra,
  });
}
const sound = (ms) => Array(ms).fill(0.5);
const silence = (ms) => Array(ms).fill(0);

test('continuous voice stays whole despite sparse ASR words, including the head and tail', () => {
  const result = segment(sound(1800), {
    words: [{ start: 200, end: 240, text: '一' }, { start: 480, end: 520, text: '二' }, { start: 1000, end: 1400, text: '三' }],
  });
  assert.deepEqual(result, [{ startMs: 0, endMs: 1800, kind: 'speech', text: '一二三' }]);
});

test('two phrases become speech / pause / speech even inside one ASR utterance', () => {
  const result = segment([...sound(1000), ...silence(500), ...sound(1000)], {
    speech: [{ startMs: 100, endMs: 2200 }],
  });
  assert.deepEqual(result.map(({ startMs, endMs, kind }) => [kind, startMs, endMs]), [
    ['speech', 0, 1000], ['silence', 1000, 1500], ['speech', 1500, 2500],
  ]);
});

test('short gaps between syllables do not split speech', () => {
  const result = segment([...sound(500), ...silence(150), ...sound(500)], {
    speech: [{ startMs: 0, endMs: 1150 }],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'speech');
});

test('an ASR word in a pause is kept once on its nearest phrase', () => {
  const result = segment([...sound(1000), ...silence(500), ...sound(1000)], {
    speech: [{ startMs: 0, endMs: 2500 }],
    words: [{ start: 1050, end: 1100, text: '尾' }, { start: 1450, end: 1550, text: '头' }],
  });
  assert.equal(result[0].text, '尾');
  assert.equal(result[2].text, '头');
});

test('isolated unassigned sound is unknown, never environmental audio', () => {
  const result = segment([...sound(500), ...silence(400), ...sound(500)], {
    speech: [{ startMs: 100, endMs: 400 }],
  });
  assert.deepEqual(result.map((span) => span.kind), ['speech', 'silence', 'unknown']);
});

test('explicit laugh remains distinct from adjacent continuous speech', () => {
  const result = segment(sound(1800), {
    speech: [{ startMs: 500, endMs: 1700 }],
    onomatopoeia: [{ startMs: 0, endMs: 500, text: '笑' }],
  });
  assert.deepEqual(result.map((span) => span.kind), ['onomatopoeia', 'speech']);
});

test('silent input cannot become speech just because ASR provided text', () => {
  assert.deepEqual(segment(silence(500), { speech: [{ startMs: 0, endMs: 500 }] }), [
    { startMs: 0, endMs: 500, kind: 'silence' },
  ]);
});

test('a long trailing pause includes the final partial frame', () => {
  const result = segment([...sound(500), ...silence(257)], { speech: [{ startMs: 0, endMs: 500 }] });
  assert.deepEqual(result.map(({ kind, startMs, endMs }) => [kind, startMs, endMs]), [
    ['speech', 0, 500], ['silence', 500, 757],
  ]);
});

test('continuous subtitle text is indivisible even across a long acoustic dip', () => {
  const words = [{ start: 0, end: 900, text: 'まだ' }, { start: 1600, end: 2400, text: '話している' }];
  const result = segment([...sound(1000), ...silence(500), ...sound(1000)], {
    words, subtitleClauses: alignJapaneseClauses('まだ話している', words),
  });
  assert.deepEqual(result.map((span) => span.kind), ['speech']);
});

test('a subtitle separator permits a cut only when waveform silence agrees', () => {
  const words = [{ start: 0, end: 900, text: 'まだ' }, { start: 1600, end: 2400, text: '話している' }];
  const subtitleClauses = alignJapaneseClauses('まだ\n話している', words);
  const input = { words, subtitleClauses };
  assert.deepEqual(segment([...sound(1000), ...silence(500), ...sound(1000)], input).map((span) => span.kind),
    ['speech', 'silence', 'speech']);
  assert.deepEqual(segment(sound(2500), input).map((span) => span.kind), ['speech']);
});

test('subtitle alignment tolerates spelling changes without shifting later clauses', () => {
  const words = [
    { start: 100, end: 500, text: '魔光を見つけた神羅みたいに' },
    { start: 1000, end: 1500, text: '俺らもお宝で' },
    { start: 1600, end: 2500, text: 'でっかくなるってわけよ' },
  ];
  assert.deepEqual(alignJapaneseClauses('魔晄を見つけた神羅みたいに\nオレらもお宝で でっかくなるってワケよ！', words), [
    { startMs: 100, endMs: 500, text: '魔晄を見つけた神羅みたいに' },
    { startMs: 1000, endMs: 1500, text: 'オレらもお宝で' },
    { startMs: 1600, endMs: 2500, text: 'でっかくなるってワケよ' },
  ]);
});

test('numbers and Latin letters remain part of subtitle body', () => {
  const words = [{ start: 0, end: 1000, text: 'FF7の第2話' }];
  assert.equal(alignJapaneseClauses('FF7の第2話', words).length, 1);
});

test('unrelated ASR cannot authorize subtitle boundary cuts', () => {
  assert.deepEqual(alignJapaneseClauses('こんにちは さようなら', [{ start: 0, end: 1000, text: 'abcdefg' }]), []);
});

test('a model cannot cut a supposed laugh out of indivisible subtitle body', () => {
  assert.throws(() => segment(sound(1800), {
    speech: [{ startMs: 500, endMs: 1800 }],
    subtitleClauses: [{ startMs: 100, endMs: 1700, text: 'ひと続きの正文' }],
    onomatopoeia: [{ startMs: 0, endMs: 500, text: '笑' }],
  }), /连续日文正文内部/);
});

test('BUC actual Seed-ASR spelling errors still anchor laugh and first spoken ネ correctly', () => {
  const entries = [
    ['い',120,360],['し',360,640],['っ',640,680],['ヒ',1320,1440],['ヒ',1480,1520],
    ['ネ',2000,2240],['ウ',2280,2560],['チ',2640,2680],['も',2760,3000],['ん',3000,3120],
    ['ぜ',3200,3240],['ぇ',3240,3280],['カ',4000,4040],['ン',4040,4320],['パ',4320,4360],
    ['ニ',4360,4560],['ラ',4560,4760],
  ];
  const words = entries.map(([text, start, end]) => ({ text, start, end }));
  const subtitleClauses = alignJapaneseClauses('いっししし\nネウチモンで カンパニーだ～！', words);
  assert.deepEqual(subtitleClauses.map((span) => [span.startMs, span.endMs]), [[120,1520],[2000,3280],[4000,4760]]);
  const result = segment([...sound(3580), ...silence(330), ...sound(1438)], {
    words, subtitleClauses, speech: subtitleClauses.slice(1),
    onomatopoeia: [{ startMs: 0, endMs: 2000, text: 'いっししし' }],
  });
  assert.deepEqual(result.map(({ kind, startMs, endMs }) => [kind, startMs, endMs]), [
    ['onomatopoeia',0,2000],['speech',2000,3580],['silence',3580,3910],['speech',3910,5348],
  ]);
});

function boundaryInput(onomatopoeia = []) {
  return {
    samples: Float32Array.from([...sound(1885), ...silence(25), ...sound(590)]),
    sampleRate: 1000, onomatopoeia,
    subtitleClauses: [{ startMs: 120, endMs: 1520 }, { startMs: 2000, endMs: 2400 }],
  };
}

test('all adjacent speech clauses get acoustic refinement even with no laugh', () => {
  const result = refinePerformanceBoundaries(boundaryInput());
  assert.equal(result.adjustments.length, 1);
  assert.equal(result.adjustments[0].reason, 'energy-valley');
  assert.ok(result.adjustments[0].cutMs >= 1890 && result.adjustments[0].cutMs <= 1905);
  assert.equal(result.clauses[0].endMs, result.clauses[1].startMs);
});

test('laugh boundary moves to the short valley, keeping weak speech onset after it', () => {
  const result = refinePerformanceBoundaries(boundaryInput([{ startMs: 0, endMs: 2000, text: '笑' }]));
  assert.equal(result.onomatopoeia[0].startMs, 0);
  assert.ok(result.onomatopoeia[0].endMs <= 1905);
  assert.equal(result.clauses[0].startMs, 0);
  assert.equal(result.clauses[1].endMs, 2500);
});

test('首字ASR起点前200ms后50ms内识别宽平底低谷，取中点而非退回首字', () => {
  const input = boundaryInput([{ startMs: 0, endMs: 2000, text: '笑' }]);
  input.samples = Float32Array.from([...sound(1840), ...silence(100), ...sound(560)]);
  const result = refinePerformanceBoundaries(input), cut = result.adjustments[0];
  assert.equal(cut.reason, 'energy-valley');
  assert.equal(cut.searchStartMs, 1800); assert.equal(cut.searchEndMs, 2050);
  assert.ok(cut.cutMs >= 1885 && cut.cutMs <= 1895);
  assert.equal(result.onomatopoeia[0].endMs, cut.cutMs);
});

test('首字ASR早报时可向后修正50ms，校正后的字幕边界仍可安全切分', () => {
  const input = boundaryInput([{ startMs: 0, endMs: 2000, text: '笑' }]);
  input.samples = Float32Array.from([...sound(2010), ...silence(30), ...sound(460)]);
  const result = refinePerformanceBoundaries(input), cut = result.adjustments[0];
  assert.equal(cut.reason, 'energy-valley'); assert.ok(cut.cutMs > 2000 && cut.cutMs <= 2050);
  assert.doesNotThrow(() => segmentPerformanceAudio({ ...input, words: [], speech: [input.subtitleClauses[1]],
    onomatopoeia: result.onomatopoeia, subtitleClauses: result.clauses }));
});

test('no clear two-sided valley means no arbitrary fixed backward shift', () => {
  const input = boundaryInput([{ startMs: 0, endMs: 2000 }]);
  input.samples = Float32Array.from(sound(2500));
  const result = refinePerformanceBoundaries(input);
  assert.equal(result.adjustments[0].reason, 'no-clear-valley');
  assert.equal(result.onomatopoeia[0].endMs, 2000);
});

test('energy valley inside an indivisible subtitle does not create a boundary', () => {
  const input = boundaryInput();
  input.subtitleClauses = [{ startMs: 120, endMs: 2400 }];
  assert.deepEqual(refinePerformanceBoundaries(input).adjustments, []);
});

test('normal phrase refinement does not collapse an existing long silence', () => {
  const samples = Float32Array.from([...sound(1000), ...silence(500), ...sound(1000)]);
  const subtitleClauses = [{ startMs: 0, endMs: 900 }, { startMs: 1600, endMs: 2400 }];
  const refined = refinePerformanceBoundaries({ samples, sampleRate: 1000, subtitleClauses, onomatopoeia: [] });
  const segments = segmentPerformanceAudio({
    samples, sampleRate: 1000, subtitleClauses, words: [], speech: subtitleClauses,
    onomatopoeia: refined.onomatopoeia,
  });
  assert.deepEqual(segments.map(({ kind, startMs, endMs }) => [kind, startMs, endMs]), [
    ['speech',0,1000],['silence',1000,1500],['speech',1500,2500],
  ]);
});

test('BEG 3100: a late ASR onset must not label speech after a long pause as FX', () => {
  const samples = Float32Array.from([...sound(340), ...silence(500), ...sound(3307)]);
  const subtitleClauses = [
    { startMs: 190, endMs: 470, text: 'けっ' },
    { startMs: 1030, endMs: 3670, text: 'そんな脅しに屈するオレたちじゃ' },
  ];
  const refined = refinePerformanceBoundaries({
    samples, sampleRate: 1000, subtitleClauses,
    onomatopoeia: [{ startMs: 0, endMs: 1030, text: 'けっ' }],
  });
  assert.equal(refined.adjustments[0].reason, 'silence-interval');
  assert.deepEqual(refined.adjustments[0].silence, { startMs: 340, endMs: 840 });
  const result = segmentPerformanceAudio({
    samples, sampleRate: 1000, subtitleClauses, words: [], speech: [subtitleClauses[1]],
    onomatopoeia: refined.onomatopoeia,
  });
  assert.deepEqual(result.map(({ kind, startMs, endMs }) => [kind, startMs, endMs]), [
    ['onomatopoeia',0,340],['silence',340,840],['speech',840,4147],
  ]);
});

const {measurePerformanceSpeakingTime}=require('./speech-segmentation.ts');
test('speaking-rate denominator excludes a long pause inside continuous unpunctuated Japanese, independently of semantic segmentation',()=>{
 const samples=new Float32Array(5000);samples.fill(.5,0,1000);samples.fill(.5,4000);
 const semantic=segmentPerformanceAudio({samples,sampleRate:1000,speech:[{startMs:0,endMs:5000}],words:[],onomatopoeia:[],subtitleClauses:[{startMs:0,endMs:5000,text:'これは連続した日本語'}]});
 assert.ok(!semantic.some(s=>s.kind==='silence'));
 const before=samples.slice(),m=measurePerformanceSpeakingTime({samples,sampleRate:1000,startS:0,endS:5});
 assert.equal(m.speechSeconds,2);assert.equal(m.pauseSeconds,3);assert.equal(12/m.speechSeconds,6);
 assert.deepEqual(m.pauses,[{startMs:1000,endMs:4000}]);assert.deepEqual(samples,before);
});
test('speaking-rate duration keeps a 240ms gap and voiced drag, but removes a 250ms quiet interval',()=>{
 for(const [gap,removed] of [[240,0],[250,.25]]){
  const samples=new Float32Array(2000+gap);samples.fill(.5,0,1000);samples.fill(.5,1000+gap);
  const m=measurePerformanceSpeakingTime({samples,sampleRate:1000,startS:0,endS:samples.length/1000});
  assert.equal(m.pauseSeconds,removed);assert.ok(Math.abs(m.speechSeconds-(removed?2:2.24))<1e-9);
 }
 const samples=new Float32Array(6000).fill(.5);const m=measurePerformanceSpeakingTime({samples,sampleRate:1000,startS:0,endS:6});assert.equal(m.speechSeconds,6);assert.equal(m.pauseSeconds,0);
});
test('speaking-rate measurement respects trimmed reference bounds and invalid/silent audio never supplies usable slow-rate evidence',()=>{
 const samples=new Float32Array(4000);samples.fill(.5,1000,3000);
 const m=measurePerformanceSpeakingTime({samples,sampleRate:1000,startS:1,endS:3});assert.equal(m.speechSeconds,2);assert.equal(m.pauseSeconds,0);
 assert.equal(measurePerformanceSpeakingTime({samples,sampleRate:0,startS:0,endS:4}),null);
 assert.equal(measurePerformanceSpeakingTime({samples:new Float32Array(2000),sampleRate:1000,startS:0,endS:2}).speechSeconds,0);
});

const {splitAsrClausesByOriginalPauses:conservativeSplit}=require('./speech-segmentation.ts');
function missedPause(ms=1200){const words=[{text:'フ',start:100,end:200},{text:'ッ',start:200,end:300},{text:'弱',start:ms+350,end:ms+450},{text:'虫',start:ms+450,end:ms+550},{text:'か',start:ms+550,end:ms+700}];return {samples:Float32Array.from([...sound(300),...silence(ms),...sound(500)]),sampleRate:1000,textJp:'ふっ 弱虫か',asrText:'フッ弱虫か。',words,clauses:alignJapaneseClauses('フッ弱虫か。',words)};}
test('原字幕有分隔且真实静音至少1秒时，先补切未分段ASR并保留ASR文字',()=>{const x=missedPause();const r=conservativeSplit(x);assert.deepEqual(r.clauses.map(c=>c.text),['フッ','弱虫か']);assert.equal(r.splits.length,1);assert.equal(r.splits[0].silence.endMs-r.splits[0].silence.startMs,1200);assert.equal(r.splits[0].cutMs,900);});
test('不足1秒、无原字幕分隔、正文不一致及只有字轴空档均不补切',()=>{
 for(const ms of [500,990])assert.equal(conservativeSplit(missedPause(ms)).splits.length,0);
 for(const mutate of [x=>x.textJp='ふっ弱虫か',x=>x.textJp='ふっ 強虫か',x=>x.samples.fill(.5),x=>x.words[1].start=150,x=>x.words[1].end=NaN,x=>{x.words=[{text:'フッ弱虫か',start:100,end:1900}];x.clauses=alignJapaneseClauses(x.asrText,x.words);}]){const x=missedPause();mutate(x);assert.equal(conservativeSplit(x).splits.length,0);}
});
test('原字幕的空格、换行、标点分隔均可作对应依据；ASR已有分界则不重复切',()=>{
 for(const separator of [' ','\n','、']){const x=missedPause();x.textJp='ふっ'+separator+'弱虫か';assert.equal(conservativeSplit(x).splits.length,1);}
 const x=missedPause();x.asrText='フッ 弱虫か。';x.clauses=alignJapaneseClauses(x.asrText,x.words);const r=conservativeSplit(x);assert.equal(r.splits.length,0);assert.deepEqual(r.clauses,x.clauses);
});
test('长停顿在原字幕分界之外不能授权补切；只补确认的边界不改其余ASR分段',()=>{
 const x=missedPause();x.words=[{text:'フ',start:100,end:150},{text:'ッ',start:150,end:200},{text:'弱',start:200,end:300},{text:'虫',start:1600,end:1750},{text:'か',start:1750,end:1900}];x.clauses=alignJapaneseClauses(x.asrText,x.words);assert.equal(conservativeSplit(x).splits.length,0);
});

test("恰好1秒满足用户的至少1秒门槛",()=>{assert.equal(conservativeSplit(missedPause(1000)).splits.length,1);});
