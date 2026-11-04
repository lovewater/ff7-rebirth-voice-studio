const {test}=require('node:test'),assert=require('node:assert/strict');
const {patchedNamePrompt,ENGLISH_ALIAS_RULE,appendEnglishAliasPrompt}=require('./name-alias-prompt.cjs');
test('English alias rule is idempotent, retains current-source safeguards, and appends a new prompt version',async()=>{
 const input='matched_in_current_source=false不得补写\n{{name_glossary}}',patched=patchedNamePrompt(input);
 assert.match(patched,/与同一条 english 标准名指向同一人物/);assert.match(patched,/false 项仍只供辨认/);assert.ok(patched.includes('matched_in_current_source=false不得补写'));assert.ok(patched.endsWith('{{name_glossary}}'));assert.equal(patchedNamePrompt(patched),patched);assert.throws(()=>patchedNamePrompt('missing placeholder'));
 const statements=[],sql=(strings,...values)=>{const text=strings.join('');statements.push({text,values});return Promise.resolve(text.includes('SELECT')?[{id:58,prompt:input,name:'旧提示词',role:'user',category:'独立翻译',placeholders:[]}]:[{id:60}]);};sql.json=x=>x;
 const version=await appendEnglishAliasPrompt(sql);assert.equal(version.previous_id,'58');assert.equal(version.new_id,'60');assert.ok(!statements.some(x=>/UPDATE|DELETE/.test(x.text)));assert.ok(statements.some(x=>x.values.some(value=>typeof value==='string'&&value.includes(ENGLISH_ALIAS_RULE))));
});
