/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const m=new Module(__filename);m.require=id=>id==='./asr-word-corrections'?require('./asr-word-corrections.ts'):id==='./spoken-text-review'?require('./spoken-text-review.ts'):require(id);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/casual-semantic-review.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
const {fastCasualSemanticEvidence:fast,parseCasualSemanticEvidence:parse,semanticEvidenceMatchesFinal:matches,casualSemanticMessages:messages}=m.exports;
const input={originalChinese:'敢动的话我就开枪。',originalBodyChinese:'敢动的话我就开枪。',candidateBodyChinese:'敢动就开枪。',fullCandidateChinese:'敢动就开枪。',sourceStage:'rewrite',asr:'敢动就开枪。',audioSha256:'a'.repeat(64),pronunciationNotes:[],literalReading:true,dictionaryReading:false,japanese:'動いたら撃つぞ',english:null,sourceEvidence:{jp:'official'},context:{before:[],after:[]},properNames:{speaker:'克劳德'},preservedOriginal:null};
const clean={faithful:true,readingEquivalent:true,needsHuman:false,readingUncertain:false,hardReadingRisk:false,negationChanged:false,questionChanged:false,entityChanged:false,missingMeaning:[],addedMeaning:[],changedMeaning:[],reason:'条件与动作对象完整，ASR可等价'};
test('independent ordinary final review recomputes the same name proof and retains original ASR hash',()=>{
 const raw='危机会帮我们确保逃生路线畅通。',text='威吉会帮我们确保逃生路线畅通！';
 const i={...input,originalChinese:text,originalBodyChinese:text,candidateBodyChinese:text,fullCandidateChinese:text,sourceStage:'original',asr:raw,literalReading:false,
  asrWordRules:[{id:7,word:'威吉',aliases:['危机'],enabled:true,note:null}]};
 const e=fast(i);assert.equal(e.passed,true);assert.equal(e.readingEquivalence,'asr-word-corrections-v1');assert.equal(e.asrWordCorrection.rawText,raw);
 assert.equal(fast({...i,asrWordRules:[]}),null);assert.equal(fast({...i,asr:'危机会帮我们'}),null);
 const payload=JSON.parse(messages(i)[1].content);assert.equal(payload.asr,'威吉会帮我们确保逃生路线畅通。');assert.equal(payload.rawAsr,raw);
 // A changed draft still requires semantic validation even when its name is fixed.
 const changed={...i,sourceStage:'rewrite',candidateBodyChinese:'威吉已经逃跑',fullCandidateChinese:'威吉已经逃跑',asr:'危机已经逃跑'};
 assert.equal(fast(changed),null);assert.equal(parse({...clean,faithful:false,changedMeaning:['动作被改变']},changed).passed,false);
});
test('faithful paraphrase can pass strict review, but a rewritten identical body never bypasses review',()=>{
 assert.equal(fast(input),null);assert.equal(parse(clean,input).passed,true);
 assert.equal(fast({...input,originalBodyChinese:input.candidateBodyChinese,originalChinese:input.fullCandidateChinese}),null);
});
test('original literal reading may fast-pass, while notes/unknown near-sounds require independent review',()=>{
 const original={...input,sourceStage:'original',candidateBodyChinese:input.originalBodyChinese,fullCandidateChinese:input.originalChinese,asr:input.originalChinese};
 assert.equal(fast(original).passed,true);
 assert.equal(fast({...original,pronunciationNotes:['实义近音待定']}),null);
 assert.equal(fast({...original,literalReading:false}),null);
 assert.equal(fast({...original,literalReading:false,dictionaryReading:true}).passed,true);
});
for(const original of ['入侵者？','你去？'])test(`${original} cannot lose its sole question marker even if a model incorrectly returns all clean`,()=>{
 const i={...input,sourceStage:'original',originalChinese:original,originalBodyChinese:original,candidateBodyChinese:original.replace('？','。'),fullCandidateChinese:original.replace('？','。')};
 assert.equal(fast(i),null);const r=parse(clean,i);assert.equal(r.passed,false);assert.equal(r.kind,'meaning');assert.match(r.feedback,/问意/);
});
test('full restored script must preserve original effects and cannot duplicate or drop them',()=>{
 const i={...input,sourceStage:'original',originalChinese:'嗯，敢动的话我就开枪。',candidateBodyChinese:input.originalBodyChinese,fullCandidateChinese:'敢动的话我就开枪。',preservedOriginal:{prefix:'嗯，',suffix:''}};
 assert.equal(fast(i),null);assert.equal(parse(clean,i).passed,false);
 assert.equal(parse(clean,{...i,fullCandidateChinese:'嗯，嗯，'+input.originalBodyChinese}).passed,false);
});
for(const key of ['negationChanged','questionChanged','entityChanged','hardReadingRisk','readingUncertain','needsHuman'])test(`${key} blocks automatic locking`,()=>{
 assert.equal(parse({...clean,[key]:true},input).passed,false);
});
test('a truncated 够/句够 verdict cannot pass simply because its duration fits',()=>{
 const i={...input,originalChinese:'用这招解决你！',originalBodyChinese:'用这招解决你！',candidateBodyChinese:'够',fullCandidateChinese:'够',asr:'够'};
 const result=parse({...clean,faithful:false,missingMeaning:['丢失用这招解决对方的动作和对象'],reason:'够/句够无法表达原句完整实义'},i);
 assert.equal(result.passed,false);assert.equal(result.kind,'meaning');assert.match(result.feedback,/动作和对象/);
});
for(const [original,asr]of [['只能硬上了吗？','是，能硬上了吗？'],['干劲来了！','赶紧来啦！']])test(`unchanged intended script ${original} with risky ASR retries the same script rather than deleting text`,()=>{
 const i={...input,sourceStage:'original',originalChinese:original,originalBodyChinese:original,candidateBodyChinese:original,fullCandidateChinese:original,asr,literalReading:false,pronunciationNotes:['近音存在实义风险']};
 assert.equal(fast(i),null);const r=parse({...clean,readingEquivalent:false,readingUncertain:true,needsHuman:true,reason:'ASR不能证明音频确实读错，但存在实义风险'},i);
 assert.equal(r.passed,false);assert.equal(r.kind,'reading');
 assert.equal(parse({...clean,reason:'独立确认等价且无实质读音风险'},i).passed,true);
});
test('schema omission, malformed risk array or absent reason fails closed',()=>{
 for(const invalid of [{},{...clean,faithful:undefined},{...clean,missingMeaning:'无'},{...clean,changedMeaning:['']},{...clean,reason:''}]){const r=parse(invalid,input);assert.equal(r.passed,false);assert.equal(r.needsHuman,true);}
});
test('review proof binds original, full script, actual ASR bytes and optionally assembled final bytes',()=>{
 const e=parse(clean,input);assert.equal(matches(e,input.originalChinese,input.fullCandidateChinese,input.audioSha256,input.audioSha256),true);
 assert.equal(matches(e,input.originalChinese+'？',input.fullCandidateChinese,input.audioSha256,input.audioSha256),false);
 assert.equal(matches(e,input.originalChinese,input.fullCandidateChinese+'？',input.audioSha256,input.audioSha256),false);
 assert.equal(matches(e,input.originalChinese,input.fullCandidateChinese,'b'.repeat(64),input.audioSha256),false);
 const assembled={...e,finalAudioSha256:'b'.repeat(64)};assert.equal(matches(assembled,input.originalChinese,input.fullCandidateChinese,'b'.repeat(64),input.audioSha256),true);
 assert.equal(matches(assembled,input.originalChinese,input.fullCandidateChinese,'b'.repeat(64),'c'.repeat(64)),false);
});
test('messages retain question punctuation, actual ASR, names, context and original separation evidence',()=>{
 const i={...input,originalChinese:'入侵者？'};const text=JSON.stringify(messages(i));assert.match(text,/入侵者？/);assert.match(text,/克劳德/);assert.match(text,/ASR/);assert.match(text,/保留JP/);assert.match(text,/needsHuman/);
});

const translated={...input,originalChinese:'',originalBodyChinese:'',checkOriginalMeaning:false,modelTranslationBaseline:'模型制作起稿。',modelTranslationSourceHash:'d'.repeat(64)};
test('without original Chinese, rewritten literal reading can pass without comparing meanings to the model baseline',()=>{
 const i={...translated,candidateBodyChinese:'另一份自然成稿。',fullCandidateChinese:'另一份自然成稿。',asr:'另一份自然成稿。'};
 const e=fast(i);assert.equal(e.passed,true);assert.equal(e.originalMeaningChecked,false);assert.equal(e.policy,'model-translation-reading-only-v1');
 const verdict=parse({...clean,faithful:false,questionChanged:true,missingMeaning:['与起稿措辞不同'],reason:'当前稿和实际ASR完全对应'},i);
 assert.equal(verdict.passed,true);assert.equal(verdict.originalMeaningChecked,false);
 assert.match(JSON.stringify(messages(i)),/不要比较当前稿与模型译文/);
});
test('no-original mode still blocks omission, uncertain reading and broken retained-component restoration',()=>{
 assert.equal(fast({...translated,literalReading:false}),null);
 for(const verdict of [{...clean,readingEquivalent:false},{...clean,readingUncertain:true},{...clean,needsHuman:true}])assert.equal(parse(verdict,translated).passed,false);
 const bad={...translated,preservedOriginal:{prefix:'嗯，',suffix:''}};assert.equal(fast(bad),null);assert.equal(parse(clean,bad).passed,false);
});
test('existing original Chinese or absent translation provenance cannot enable the no-original meaning exception',()=>{
 for(const i of [{...translated,originalChinese:'真实原中文'},{...translated,modelTranslationSourceHash:undefined},{...translated,modelTranslationBaseline:''}]){assert.equal(fast(i),null);assert.equal(parse(clean,i).passed,false);}
});

test('reference translations reach the reviewer and are bound to each verdict without bypassing semantic or reading gates',()=>{
 const i={...input,japaneseChineseTranslation:'恢复状态，重新站起',englishChineseTranslation:'恢复状态，重新集结。'};
 const request=messages(i),payload=JSON.parse(request[1].content);
 assert.equal(payload.japaneseChineseTranslation,i.japaneseChineseTranslation);assert.equal(payload.englishChineseTranslation,i.englishChineseTranslation);
 assert.match(request[0].content,/不得仅因未复述/);assert.match(request[0].content,/可能出错/);
 assert.notEqual(parse(clean,i).inputHash,parse(clean,{...i,japaneseChineseTranslation:'不同译文'}).inputHash);
 assert.equal(parse({...clean,faithful:false,missingMeaning:['真实否定被删']},i).passed,false);
 assert.equal(parse({...clean,readingUncertain:true},i).passed,false);assert.equal(fast(i),null);
});

for(const [reference,key] of [['japanese-translation','japaneseChineseTranslation'],['english-translation','englishChineseTranslation']])test(`${reference} can independently support a paraphrase, with question checks on that reference`,()=>{
 const i={...input,originalChinese:'恢复了吗？',originalBodyChinese:'恢复了吗？',candidateBodyChinese:'恢复状态，重新战斗。',fullCandidateChinese:'恢复状态，重新战斗。',[key]:'恢复状态后再战。'};
 assert.equal(parse({...clean,meaningReference:reference},i).passed,true);assert.equal(parse({...clean,meaningReference:reference},i).meaningReference,reference);
 assert.equal(parse({...clean,meaningReference:reference},{...i,[key]:null}).passed,false);
 assert.equal(parse({...clean,meaningReference:reference},{...i,[key]:'恢复了吗？'}).passed,false);
 assert.equal(parse({...clean,meaningReference:reference,negationChanged:true},i).passed,false);
});

test('proven natural erhua can fast-pass an unchanged ordinary script but lexical 儿 and added 一 cannot',()=>{
 const i={...input,sourceStage:'original',originalChinese:'待会再说',originalBodyChinese:'待会再说',candidateBodyChinese:'待会再说',fullCandidateChinese:'待会再说',asr:'待会儿再说。',literalReading:false,naturalErhuaReading:true};
 assert.equal(fast(i).passed,true);assert.match(fast(i).reason,/自然儿化/);
 assert.equal(fast({...i,asr:'待一会儿再说。'}),null);
 assert.equal(fast({...i,originalChinese:'女儿来了',originalBodyChinese:'女儿来了',candidateBodyChinese:'女儿来了',fullCandidateChinese:'女儿来了',asr:'女来了'}),null);
 assert.equal(fast({...i,naturalErhuaReading:false}),null);
 assert.match(JSON.stringify(messages(i)),/不能全局忽略儿/);
});
