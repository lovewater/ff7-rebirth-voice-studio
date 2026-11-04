/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {correctAsrWords:fix,validateAsrWordRule:validate,asrComparisonBody:body}=require('./asr-word-corrections.ts');
const rules=[{id:1,word:'威吉',aliases:['危机','危急','微机','维基'],enabled:true,note:null},
 {id:2,word:'克劳德',aliases:['克劳得','克老的'],enabled:true,note:null},
 {id:3,word:'赤红十三',aliases:['赤红13'],enabled:true,note:null}];
test('known name aliases only affect aligned occurrences, preserving raw ASR and input objects',()=>{
 const raw='危机发现危机。',snapshot=JSON.stringify(rules);const e=fix('威吉发现危机。',raw,rules);
 assert.equal(e.correctedText,'威吉发现危机。');assert.equal(e.rawText,raw);assert.equal(e.hits.length,1);assert.equal(e.hits[0].asrStart,0);assert.equal(e.hits[0].ruleId,1);assert.equal(JSON.stringify(rules),snapshot);
 assert.equal(fix('危机就在威吉身后','危机就在危机身后',rules).correctedText,'危机就在威吉身后');
});
test('a canonical name somewhere in the script does not cause global substitution of legitimate words',()=>{
 assert.equal(fix('这场危机很严重','这场危机很严重',rules).correctedText,'这场危机很严重');
 assert.equal(fix('威吉说这场危机很危险','危机说这场危机很危险',rules).correctedText,'威吉说这场危机很危险');
});
test('multiple names and repeated canonical occurrences retain individual alignment evidence',()=>{
 const e=fix('威吉叫克劳德等威吉','危机叫克劳得等微机',rules);assert.equal(e.correctedText,'威吉叫克劳德等威吉');assert.equal(e.hits.length,3);
});
test('ambiguous name occurrence remains raw',()=>{
 const e=fix('威吉威吉','危机',rules);assert.equal(e.reason,'ambiguous');assert.equal(e.correctedText,'危机');assert.deepEqual(e.hits,[]);
});
test('correction never makes missing, extra or repeated lexical words disappear',()=>{
 for(const raw of ['危机会帮我们','危机会会帮我们撤退','危机会帮我们撤退啊']) {
  assert.notEqual(body(fix('威吉会帮我们撤退',raw,rules).correctedText),'威吉会帮我们撤退');
 }
});
test('disabled, unlisted, empty and over-limit inputs do not gain correction proof',()=>{
 assert.equal(fix('威吉来了','危机来了',rules.map(r=>({...r,enabled:false}))).hits.length,0);
 assert.equal(fix('威吉来了','伟基来了',rules).hits.length,0);
 assert.equal(fix('威吉来了','',rules).hits.length,0);
 assert.equal(fix('威吉'+'甲'.repeat(1500),'危机'+'甲'.repeat(1500),rules).reason,'size-limit');
});
test('configured variable-length and numeric aliases do not change adjacent words',()=>{
 const e=fix('赤红十三来找威吉','赤红13来找维基',rules);assert.equal(e.correctedText,'赤红十三来找威吉');assert.equal(e.hits.length,2);
});
test('normalization ignores ordinary punctuation without NFKC or arbitrary homophones',()=>{
 assert.equal(fix('威吉，快走！','危机，快走！',rules).correctedText,'威吉，快走！');
 assert.equal(fix('威吉Ａ','危机A',rules).correctedText,'威吉A');
 assert.notEqual(body(fix('威吉Ａ','危机A',rules).correctedText),body('威吉Ａ'));
});
test('API validates bounded alias groups and never accepts an empty/all-self group',()=>{
 assert.deepEqual(validate({word:' 威吉 ',aliases:[' 危机 ','危机','微机'],note:' 备注 '}),{word:'威吉',aliases:['危机','微机'],enabled:true,note:'备注'});
 for(const bad of [null,{}, {word:'威 吉',aliases:['危机']},{word:'威吉',aliases:[]},{word:'威吉',aliases:['威吉']},{word:'威吉',aliases:['危 机']},{word:'威吉',aliases:[3]},{word:'威吉',aliases:['危机'],enabled:'yes'}])assert.throws(()=>validate(bad));
});
