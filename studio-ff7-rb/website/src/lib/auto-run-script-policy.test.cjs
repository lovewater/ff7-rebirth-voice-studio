/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scriptClauses, performanceSegmentationHint, checkAutoBeat } = require('./auto-run-script-policy.ts');
const { closestFallback } = require('./auto-run-fallback.ts');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');
// Load the actual prompt builder under Node; the app's bundler normally resolves extensionless TS imports.
const promptModule = new Module(__filename);
promptModule.require = (id) => require(id === './beats' ? './beats.ts' : id === './auto-run-script-policy' ? './auto-run-script-policy.ts' : id);
promptModule._compile(ts.transpileModule(readFileSync(`${__dirname}/rewrite-prompt.ts`, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, `${__dirname}/rewrite-prompt.ts`);
const { rewriteMessages } = promptModule.exports;
const result = (ratio, status = 'ok') => ({ normalizedRatio: ratio, jp: { status } });

test('length passing cannot rescue extreme normalized beats; endpoints are inclusive', () => {
  for (const ratio of [.85, 1, 1.15]) assert.equal(checkAutoBeat(result(ratio)).pass, true);
  for (const ratio of [.849, 1.151, .3, 3]) assert.equal(checkAutoBeat(result(ratio)).pass, false);
});
test('short JP is exempt; unavailable/invalid beat data cannot masquerade as passing', () => {
  assert.deepEqual(checkAutoBeat(result(null, 'short')), { enabled: false, ratio: null, pass: true, deviation: 0 });
  for (const value of [null, NaN, Infinity, -1, 0]) assert.equal(checkAutoBeat(result(value)).pass, false);
  assert.equal(checkAutoBeat(null).pass, false);
});
test('Japanese and Chinese split at spaces, punctuation and newlines, with no empty clauses', () => {
  assert.deepEqual(scriptClauses('魔晄を見つけた神羅みたいに\nオレらもお宝で でっかくなるってワケよ！'),
    ['魔晄を見つけた神羅みたいに', 'オレらもお宝で', 'でっかくなるってワケよ']);
  assert.deepEqual(scriptClauses('甲　乙，\n！？ 丙\\n丁。'), ['甲', '乙', '丙', '丁']);
});
test('automatic scene prompt asks for Japanese clause count without enforcing original CN lines in later feedback', () => {
  const hint = performanceSegmentationHint('甲、乙\n丙');
  const input = { speaker: '', show: null, textJp: '甲、乙\n丙', textEn: '', original: '一行', current: '一行',
    beats: { jp: { units: 30 }, cn: { units: 20 } }, before: [], after: [],
    previous: [{ raw: '{}', units: 20, spokenUnits: 23 }], segmentationHint: hint };
  for (const attempt of [0, 2, 5]) {
    const text = rewriteMessages({ ...input, attempt }).map((row) => row.content).join('\n');
    assert.match(text, /分为 3 段/);
    assert.match(text, /尽量也写成 3 段/);
    assert.match(text, /空格、标点符号或换行/);
    assert.match(text, /不是硬性段数限制/);
    assert.doesNotMatch(text, /保持原字幕行数|行数不变|请保持 1 行|必须正好/);
  }
  const manual = rewriteMessages({ ...input, segmentationHint: undefined }).map((row) => row.content).join('\n');
  assert.match(manual, /请保持 1 行/);
});
test('fallback accounts for both span and beat deviations across all rounds', () => {
  const base = { reviewed: true, hardIssueCount: 0, pronunciationIssueCount: 0, durationDeviation: 0 };
  assert.equal(closestFallback([
    { ...base, id: 'length-only', paceDeviation: 0, beatDeviation: 2 },
    { ...base, id: 'closer', paceDeviation: .16, beatDeviation: .05 },
  ]).id, 'closer');
});

test('short automatic rewrite has no normal beat target or beat-based feedback', () => {
  const messages = rewriteMessages({ speaker:'', show:null, textJp:'オトリか！',textEn:'A decoy!',original:'诱饵吗！',current:'诱饵！',
    beats:{jp:{units:null},cn:{units:2}},before:[],after:[],previous:[{raw:'{}',units:2}],shortLine:{min:3,max:4,target:3} });
  const text=messages.map(m=>m.content).join('\n');
  assert.match(text,/3–4/);
  assert.match(text,/不计算、不追求拍数比/);
  assert.match(text,/问句/);
  assert.match(text,/未达上限时，应增加当前正文的字符数/);
  assert.match(text,/若已经达到上限/);
  assert.match(text,/标点.*安排停顿/);
  assert.match(text,/实际发声时长/);
  assert.doesNotMatch(text,/优先尝试 3 字/);
  assert.doesNotMatch(text,/0\.9|1\.1|NaN|null 拍|目标约|偏快|偏慢/);
});
test('fallback prefers a short candidate within character limits when hard text issues tie',()=>{
  const base={reviewed:true,hardIssueCount:0,pronunciationIssueCount:0,durationDeviation:0,beatDeviation:0};
  assert.equal(closestFallback([
    {...base,id:'too-few-characters',paceDeviation:0,characterDeviation:1},
    {...base,id:'keeps-question',paceDeviation:.2,characterDeviation:0},
  ]).id,'keeps-question');
});

const {slowPerformancePolicy,shortPerformancePolicy}=require('./auto-run-script-policy.ts');
test('slow exemption is strictly below three pure mora per second; unknown rate never grants exemption',()=>{
 assert.equal(slowPerformancePolicy(12,4),null);
 assert.equal(slowPerformancePolicy(12,3.99),null);
 assert.equal(slowPerformancePolicy(12,4.01).target,12);
 for(const n of [null,undefined,0,-1,NaN,Infinity])assert.equal(slowPerformancePolicy(n,5),null);
 for(const seconds of [null,0,-1,NaN,Infinity])assert.equal(slowPerformancePolicy(12,seconds),null);
});
test('short or slow is sufficient independently; a normal longer sentence remains subject to ratio checks',()=>{
 const exempt=(text,mora,seconds)=>Boolean(shortPerformancePolicy(text,1.33)||slowPerformancePolicy(mora,seconds));
 assert.equal(exempt('オトリか',null,1),true);
 assert.equal(exempt('これはゆっくり話す台詞',12,5),true);
 assert.equal(exempt('これはゆっくり話す台詞',12,2),false);
});
test('slow rewrite prompts ask for near one Chinese character per mora and never reintroduce ordinary ratio feedback',()=>{
 const slowLine=slowPerformancePolicy(12,5);
 const messages=rewriteMessages({speaker:'',show:null,textJp:'これはゆっくり話す台詞',textEn:'',original:'原文',current:'当前稿',beats:{jp:{units:90},cn:{units:2}},before:[],after:[],previous:[{raw:'{}',units:1}],slowLine});
 const prompt=messages.map(m=>m.content).join('\n');
 assert.match(prompt,/低于3拍/);assert.match(prompt,/接近或等于 12/);assert.match(prompt,/必须增加正文字符/);
 assert.match(prompt,/标点、空格、引号、换行不算/);
 assert.doesNotMatch(prompt,/目标约|0\.85|1\.15|67\.6|90 拍/);
});

test('8–11 JP body characters use inclusive .75–1.10; punctuation cannot change the band',()=>{
 const {autoBeatBand,compactPerformanceBeatBand}=require('./auto-run-script-policy.ts');
 for(const text of ['甲乙丙丁戊己庚辛','甲乙丙丁戊己庚辛壬癸子','「甲乙丙丁，戊己！庚辛」']){
  assert.deepEqual(autoBeatBand(text),{low:.75,high:1.10});
  for(const ratio of [.75,.8,1,1.10])assert.equal(checkAutoBeat(result(ratio),text).pass,true);
  for(const ratio of [.749,1.101])assert.equal(checkAutoBeat(result(ratio),text).pass,false);
  assert.equal(checkAutoBeat(result(null),text).pass,false);
 }
 for(const text of ['甲乙丙丁戊己庚','甲乙丙丁戊己庚辛壬癸子丑',''])assert.equal(compactPerformanceBeatBand(text),null);
 assert.equal(checkAutoBeat(result(.8),'甲乙丙丁戊己庚辛壬癸子丑').pass,false);
 assert.equal(checkAutoBeat(result(null,'short'),'甲乙丙丁戊己庚').enabled,false);
});
test('compact rewrites use the same band in first turn, second round and feedback',()=>{
 const input={speaker:'',show:null,textJp:'甲乙丙丁戊己庚辛',textEn:'',original:'原中文',current:'当前稿',beats:{jp:{units:10},cn:{units:10}},before:[],after:[],previous:[{raw:'{}',units:10,spokenUnits:10}]};
 for(const attempt of [0,2,5]){
  const messages=rewriteMessages({...input,attempt});
  const text=messages.filter(m=>m.role!=='assistant').map(m=>m.content).join('\n');
  assert.match(text,/0.75[ 到–]+1.1/);assert.doesNotMatch(text,/0.9[ 到–]+1.1/);
  for(const m of messages.filter(m=>m.promptKey)){assert.equal(m.promptValues.beat_min,.75);assert.equal(m.promptValues.beat_max,1.1);}
 }
 assert.equal(promptModule.exports.rewritePace(.8,input.textJp),'正常');
 assert.equal(promptModule.exports.rewritePace(.8,'甲乙丙丁戊己庚辛壬癸子丑'),'偏快');
});
