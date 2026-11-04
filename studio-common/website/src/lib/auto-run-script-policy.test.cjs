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
test('fallback keeps span and beat dimensions independent and selects measured duration across all rounds', () => {
  const base = { reviewed: true, hardIssueCount: 0, pronunciationIssueCount: 0, durationDeviation: 0 };
  assert.equal(closestFallback([
    { ...base, id: 'length-only', durationDeviation:.01, paceDeviation: 0, beatDeviation: 2 },
    { ...base, id: 'better-beat', durationDeviation:.2, paceDeviation: .16, beatDeviation: .05 },
  ]).id, 'length-only');
});

test('short automatic rewrite has no normal beat target or beat-based feedback', () => {
  const messages = rewriteMessages({ speaker:'', show:null, textJp:'オトリか！',textEn:'A decoy!',original:'诱饵吗！',current:'诱饵！',
    beats:{jp:{units:null},cn:{units:2}},before:[],after:[],previous:[{raw:'{}',units:2}],shortLine:{jpCharacters:4} });
  const text=messages.map(m=>m.content).join('\n');
  assert.doesNotMatch(text,/3–4|必须.*个字符/);
  assert.match(text,/不设字数上下限或目标/);
  assert.match(text,/不计算、不追求拍数比/);
  assert.match(text,/问句/);
  assert.match(text,/不能为凑字增加/);

  assert.match(text,/标点.*安排停顿/);
  assert.match(text,/有效发声时长/);
  assert.doesNotMatch(text,/优先尝试 3 字/);
  assert.doesNotMatch(text,/0\.9|1\.1|NaN|null 拍|目标约|偏快|偏慢/);
});
test('after all short candidates fail, character limits do not override closest duration in fallback',()=>{
  const base={reviewed:true,hardIssueCount:0,pronunciationIssueCount:0,durationDeviation:0,beatDeviation:0};
  assert.equal(closestFallback([
    {...base,id:'closest-duration',durationDeviation:.01,paceDeviation:0,characterDeviation:1},
    {...base,id:'keeps-question',durationDeviation:.2,paceDeviation:.2,characterDeviation:0},
  ]).id,'closest-duration');
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
test('仅字数方向与整轮实测长度冲突才撤掉摩拉目标，包含相等字数',()=>{
 const {slowMoraTargetConflict}=require('./auto-run-script-policy.ts');
 const policy=slowPerformancePolicy(5,2.317);
 const rows=(...values)=>values.map(candidateSeconds=>({referenceSeconds:2.317,candidateSeconds}));
 for(const text of ['甲乙丙丁戊','甲乙丙丁戊己'])assert.equal(slowMoraTargetConflict(policy,text,rows(1.556,1.6)),'longer');
 for(const text of ['甲乙丙丁戊','甲乙丙丁'])assert.equal(slowMoraTargetConflict(policy,text,rows(2.8,2.9)),'shorter');
 assert.equal(slowMoraTargetConflict(policy,'甲乙丙丁',rows(1.5)),null);
 assert.equal(slowMoraTargetConflict(policy,'甲乙丙丁戊己',rows(2.8)),null);
 for(const r of [[],rows(1.5,2.8),rows(2.2),rows(2.117),rows(NaN),rows(0)])assert.equal(slowMoraTargetConflict(policy,'甲乙丙丁戊',r),null);
});
test('程序触发后首稿及所有后续候选都改用时长提示词，不再要求凑摩拉目标',()=>{
 for(const direction of ['longer','shorter']){
  const slowLine={...slowPerformancePolicy(5,2.317),durationDirection:direction,max:8};
  const messages=rewriteMessages({speaker:'',show:null,textJp:'このジジイ',textEn:'',original:'原文',current:'当前稿',beats:{jp:{units:5},cn:{units:6}},before:[],after:[],previous:[{raw:'{}',units:6}],slowLine});
  const prompt=messages.map(m=>m.content).join('\n');
  assert.equal(messages[0].promptKey,'rewrite.slow.duration-system');
  assert.equal(messages.at(-1).promptKey,'rewrite.slow.duration-followup');
  assert.doesNotMatch(prompt,/补足到接近或等于|正文尽量接近或等于|怎样自然增字/);
  assert.match(prompt,/正文最多8字/);
  assert.match(prompt,direction==='longer'?/达到或超过.*仍明显偏短/:/不多于.*仍明显偏长/);
 }
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

test('中文净语速硬上限仅限至少6个汉字，短情绪表达豁免且静音不能充长',()=>{
 const {checkChineseSpeakingSpeed}=require('./auto-run-script-policy.ts');
 assert.equal(checkChineseSpeakingSpeed('是谁？！',.1).pass,true);
 assert.equal(checkChineseSpeakingSpeed('甲乙丙丁戊',.1).enabled,false);
 assert.equal(checkChineseSpeakingSpeed('甲乙丙丁戊己',.6).pass,false);
 assert.equal(checkChineseSpeakingSpeed('甲乙丙丁戊己',6/9).pass,true);
 assert.equal(checkChineseSpeakingSpeed('甲乙丙，丁戊己！',.6).hanCharacters,6);
 assert.equal(checkChineseSpeakingSpeed('甲乙丙丁戊己',null).pass,false);
});
