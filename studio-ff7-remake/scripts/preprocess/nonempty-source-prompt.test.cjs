const {test}=require('node:test'),assert=require('node:assert/strict');
const {NONEMPTY_SOURCE_RULE,patchedSystem,appendNonemptySourceSystem}=require('./nonempty-source-prompt.cjs');
const {parseIndependentTranslation}=require('./policy.cjs');
test('literal Japanese 空 is nonempty source and retains the existing strict guard, while actual empty ASR keeps its separate empty result',()=>{
 for(const source of ['空。','空','　空。　'])assert.throws(()=>parseIndependentTranslation('{"translation":""}',source),{code:'invalid-translation-json'});
 assert.deepEqual(parseIndependentTranslation('{"translation":"天空。"}','空。'),{text:'天空。',state:'translated'});
 assert.deepEqual(parseIndependentTranslation('{"translation":""}',''),{text:'',state:'untranslatable_empty'});
 assert.throws(()=>parseIndependentTranslation('{"translation":"天空。"}',''),/empty-source-invented-translation/);
});
test('literal-source prompt preserves existing system instructions and appends a reviewed version without changing the old row',async()=>{
 const original='只译当前源语言，不翻前后文。',patched=patchedSystem(original);assert.ok(patched.endsWith(original));assert.equal(patchedSystem(patched),patched);assert.match(NONEMPTY_SOURCE_RULE,/不是识别状态或音频元数据/);assert.match(NONEMPTY_SOURCE_RULE,/不编造正文、不改ASR原文/);
 const statements=[],sql=(strings,...values)=>{const text=strings.join('');statements.push({text,values});return Promise.resolve(text.includes('SELECT')?[{id:45,name:'旧系统规则',role:'system',prompt:original,category:'独立翻译',placeholders:[]}]:[{id:61}]);};sql.json=x=>x;
 const result=await appendNonemptySourceSystem(sql);assert.equal(result.previous_id,'45');assert.equal(result.new_id,'61');assert.ok(statements.some(x=>x.text.includes("'translation.independent.system'")));assert.ok(!statements.some(x=>/UPDATE|DELETE/.test(x.text)));
});
