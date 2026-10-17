// node --experimental-strip-types --test src/lib/spoken-text-review.test.cjs
/* eslint-disable @typescript-eslint/no-require-imports -- Node CJS runner loads the pure TS rules. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseSpokenReview,fewestPronunciationIssues,shouldRetrySameScript,spokenReviewMessages}=require('./spoken-text-review.ts');
const review=(overrides={},asr='完整正文')=>parseSpokenReview({
  pass:true,missing:[],extra:[],repeated:[],unrelated:[],pronunciationNotes:[],reason:'内容完整',...overrides,
},asr);

test('a missing short word defeats even an incorrect model pass summary',()=>{
  const result=review({missing:['就像→像，缺少“就”']});
  assert.equal(result.ok,false);
  assert.equal(result.modelPass,true);
});

test('extra, repeated and unrelated content each independently disqualify a clip',()=>{
  for(const field of ['extra','repeated','unrelated'])assert.equal(review({[field]:['具体硬伤']}).ok,false);
});

test('near sounds, tone and light-tone notes cannot by themselves disqualify a clip',()=>{
  const result=review({pass:false,pronunciationNotes:['珍品→真币，近音','啦→了，声调差异']});
  assert.equal(result.ok,true);
  assert.equal(result.pronunciationIssueCount,2);
});

test('ASR silence or punctuation-only output cannot accidentally pass',()=>{
  for(const asr of ['', '  ', '……！'])assert.equal(review({},asr).ok,false);
});

test('bad structured evidence fails explicitly instead of assuming no issues',()=>{
  assert.throws(()=>review({missing:undefined}),/missing/);
  assert.throws(()=>review({pronunciationNotes:'近音'}),/pronunciationNotes/);
  assert.throws(()=>review({missing:['']}),/missing/);
  assert.throws(()=>review({pass:'true'}),/布尔/);
});

test('duplicate notes do not increase the candidate penalty',()=>{
  assert.equal(review({pronunciationNotes:['近音',' 近音 ']}).pronunciationIssueCount,1);
});

test('hard failures are excluded before choosing the fewest mild issues',()=>{
  const candidates=[
    {id:'missing-word',...review({missing:['缺就']})},
    {id:'two-notes',...review({pronunciationNotes:['甲','乙']})},
    {id:'one-note',...review({pronunciationNotes:['甲']})},
  ];
  assert.deepEqual(fewestPronunciationIssues(candidates.filter(row=>row.ok)).map(row=>row.id),['one-note']);
});

test('tied best candidates remain available for later rhythm selection',()=>{
  const candidates=[{id:1,pronunciationNotes:[]},{id:2,pronunciationNotes:['近音']},{id:3,pronunciationNotes:[]}];
  assert.deepEqual(fewestPronunciationIssues(candidates).map(row=>row.id),[1,3]);
  assert.deepEqual(fewestPronunciationIssues([]),[]);
});

test('all rejected clips trigger same-script retry, never a relaxed winner',()=>{
  const candidates=[review({missing:['缺字']}),review({repeated:['重复']})];
  const passing=candidates.filter(row=>row.ok);
  assert.deepEqual(fewestPronunciationIssues(passing),[]);
  assert.equal(shouldRetrySameScript(passing.length),true);
  assert.equal(shouldRetrySameScript(1),false);
});

test('judge input includes the actual script and pronunciation substitutions',()=>{
  const messages=spokenReviewMessages({spoken:'魔晄',asr:'魔皇',lexicon:[{src:'魔晄',dst:'魔恍',note:'读音'}]});
  assert.match(messages[0].content,/魔晄→魔恍/);
  assert.match(messages[1].content,/朗读稿：\n魔晄/);
  assert.match(messages[1].content,/ASR：\n魔皇/);
});
