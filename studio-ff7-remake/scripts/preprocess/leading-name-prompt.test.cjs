const {test}=require('node:test'),assert=require('node:assert/strict');
const {LEADING_NAME_RULE,patchedInput,appendLeadingNameInput}=require('./leading-name-prompt.cjs');
const {renderPrompt}=require('./policy.cjs'),names=require('./names.cjs');
test('current-line rule retains multiline vocatives as content, while keeping context outside the translation target',()=>{
 const template='源语言：{{sourceLanguage}}\ncurrent：{{current}}\nbefore：{{before}}\nafter：{{after}}';
 const source='クラウド\nウェッジを送ってやってくれ',out=renderPrompt(patchedInput(template),{sourceLanguage:'日文',current:source,before:[{text:'前文のみ'}],after:[{text:'後文のみ'}]});
 assert.ok(out.includes(source));assert.match(out,/行首单独出现的人名、称呼、呼语也属于当前条/);assert.match(out,/不是说话人标签/);assert.match(out,/before\/after 仅帮助理解，不翻译、不搬入/);
 assert.equal(patchedInput(patchedInput(template)),patchedInput(template));assert.ok(!LEADING_NAME_RULE.includes('威吉'));assert.ok(!LEADING_NAME_RULE.includes('克劳德'));
});
test('leading-name fix retains the existing strict name check: omitting Cloud still fails, complete source-based translation passes',()=>{
 const entries=names.compileNames({entries:[{english:'Cloud',japanese:'クラウド',chinese:'克劳德',english_aliases:['Cloud'],matchable:true},{english:'Wedge',japanese:'ウェッジ',chinese:'威吉',english_aliases:['Wedge'],matchable:true}]}).entries;
 assert.throws(()=>names.validateNames('把威吉送过去。','クラウド\nウェッジを送ってやってくれ','jp',entries),{code:'translation-name-mismatch'});
 names.validateNames('克劳德，送威吉回去吧。','クラウド\nウェッジを送ってやってくれ','jp',entries);
});
test('prompt installation appends a reviewed version and never modifies or disables the previous template',async()=>{
 const statements=[],old={id:46,name:'独立翻译输入',prompt:'{{current}}',role:'user',category:'独立翻译',placeholders:[]};
 const sql=(strings,...values)=>{const text=strings.join('');statements.push({text,values});return Promise.resolve(text.includes('SELECT')?[old]:[{id:59}]);};sql.json=x=>x;
 assert.deepEqual((await appendLeadingNameInput(sql)).previous_id,'46');assert.ok(statements.some(x=>x.text.includes('INSERT INTO prompt_templates')));assert.ok(!statements.some(x=>/UPDATE|DELETE/.test(x.text)));
 assert.ok(statements.at(-1).values.some(value=>typeof value==='string'&&value.startsWith(LEADING_NAME_RULE)));
});
