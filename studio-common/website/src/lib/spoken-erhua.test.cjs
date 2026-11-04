/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function setup(){
 const calls=[];const m=new Module(__filename);
 m.require=id=>id==='./asr-word-corrections'?require('./asr-word-corrections.ts'):id==='./inline-pinyin'?require('./inline-pinyin.ts'):id==='./spoken-text-review'?require('./spoken-text-review.ts'):
  id==='./auto-run-two-parts'?{performanceRewriteMessages:m=>m}:id==='./rewrite-translation-reference'?{withTranslationReferences:async m=>m}:
  id==='./rewrite-number-hint'?{withRewriteNumberHint:m=>m}:id==='./llm-metrics'?{currentLlmStem:()=> 'TEST'}:
  id==='./prompt-store'?{resolvePromptMessages:async m=>m.map(x=>({role:x.role,content:x.promptKey?'Database-owned prompt':x.content}))}:
  id==='./llm-chat-client'?{callChatCompletion:async request=>{calls.push(request);return {content:JSON.stringify({pass:false,missing:[],extra:['额外的一'],repeated:[],unrelated:[],pronunciationNotes:[],reason:'比稿件多了一'}),thinking:''};}}:{};
 m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/auto-run-llm.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__dirname+'/auto-run-llm.ts');
 return {api:m.exports,calls};
}
test('shared judge used by performance and ordinary flows accepts only natural erhua without a paid request',async()=>{
 const {api,calls}=setup();const result=await api.judgeSpokenText({spoken:'待会再说',asr:'待会儿再说。',lexicon:[]});
 assert.equal(result.ok,true);assert.equal(result.readingEquivalence,'natural-erhua-v1');assert.equal(result.modelPass,null);assert.equal(calls.length,0);
});
test('other added characters still reach the model with the explicit erhua exception and fail',async()=>{
 const {api,calls}=setup();const result=await api.judgeSpokenText({spoken:'待会再说',asr:'待一会儿再说。',lexicon:[]});
 assert.equal(result.ok,false);assert.equal(calls.length,1);assert.ok(calls[0].messages.some(m=>m.content.includes('自然儿化专项规则')));
});
test('configured names bypass the paid reviewer only after an exact corrected reading',async()=>{
 const {api,calls}=setup(),rules=[{id:1,word:'威吉',aliases:['危机'],enabled:true,note:null}];
 const raw='危机会帮我们确保逃生路线畅通。';
 const result=await api.judgeSpokenText({spoken:'威吉会帮我们确保逃生路线畅通！',asr:raw,lexicon:[],asrWordRules:rules});
 assert.equal(result.ok,true);assert.equal(result.modelPass,null);assert.equal(result.readingEquivalence,'asr-word-corrections-v1');
 assert.equal(result.asrWordCorrection.rawText,raw);assert.equal(calls.length,0);assert.deepEqual(result.pronunciationNotes,[]);
});
test('name correction plus an actual added character still reaches the strict model',async()=>{
 const {api,calls}=setup(),rules=[{id:1,word:'威吉',aliases:['危机'],enabled:true,note:null}];
 const result=await api.judgeSpokenText({spoken:'威吉等会',asr:'危机等一会',lexicon:[],asrWordRules:rules});
 assert.equal(result.ok,false);assert.equal(calls.length,1);
 assert.ok(calls[0].messages.some(m=>m.content.includes('当前朗读稿对应位置')||m.content.includes('ASR已按用户配置')));
});
