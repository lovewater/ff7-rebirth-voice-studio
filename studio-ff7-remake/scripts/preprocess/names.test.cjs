const {test}=require('node:test'),assert=require('node:assert/strict');
const names=require('./names.cjs'),{nameReviewEligibility}=require('./name-review.cjs'),{hash}=require('./policy.cjs');
const cloud={english:'Cloud',japanese:'クラウド',chinese:'克劳德',english_aliases:['Cloud'],matchable:true};
const folia={english:'Ms. Folia',japanese:'フォリア先生',chinese:'费莉亚老师',english_aliases:['Ms. Folia'],matchable:true,japanese_aliases:[{text:'フォリア',verified:true,evidence:{source:'official-name-example'}}]};
const generic={english:'Customer',japanese:'客',chinese:'客人',english_aliases:['Customer'],matchable:false};
const catalog=names.compileNames({revision:'test',entries:[cloud,folia,generic]});
test('Japanese names match directly with particles, honorifics and NFKC, without requiring English subtitle',()=>{
 for(const text of ['クラウドは来た','クラウドさん、行こう','クラウド君','ｸﾗｳﾄﾞも一緒'])assert.deepEqual(names.currentJapaneseNames(text,catalog).map(x=>x.chinese),['克劳德']);
 assert.deepEqual(names.currentNames('クラウドは？','',catalog).map(x=>x.chinese),['克劳德']);
 assert.throws(()=>names.validateNames('克劳迪在哪里？','クラウドは？','jp',catalog.entries),{code:'translation-name-mismatch'});
 names.validateNames('克劳德在哪？','クラウドは？','jp',catalog.entries);
});
test('only canonical and explicitly verified Japanese aliases match, never guessed ASR spellings',()=>{
 assert.deepEqual(names.currentJapaneseNames('フォリアさん',catalog).map(x=>x.chinese),['费莉亚老师']);
 const unverified=names.compileNames({entries:[{...cloud,japanese_aliases:['クライド',{text:'クロウド',verified:false,evidence:'unconfirmed'}]}]});
 assert.deepEqual(names.currentJapaneseNames('クライドもクロウドも来た',unverified),[]);
 const verified=names.compileNames({entries:[{...cloud,japanese_aliases:['クライド'],japanese_aliases_verified:true}]});assert.equal(names.currentJapaneseNames('クライドは',verified).length,1);
});
test('longest Japanese name or alias wins and generic substring never becomes an enforced proper name',()=>{
 const full={...cloud,english:'Cloud Full',japanese:'クラウド・ストライフ',chinese:'克劳德·斯特莱夫'};
 const c=names.compileNames({entries:[cloud,full,generic]});
 assert.deepEqual(names.currentJapaneseNames('クラウド・ストライフさん',c).map(x=>x.english),['Cloud Full']);
 assert.deepEqual(names.currentJapaneseNames('乗客とお客様',catalog),[]);
});
test('English-only name hints do not force names absent from the current Japanese source, or vice versa',()=>{
 const union=names.currentNames('行こう。','Cloud, let us go.',catalog);assert.equal(union.length,1);
 assert.equal(names.promptNames(union,'行こう。','jp')[0].matched_in_current_source,false);
 names.validateNames('行こう','行こう。','jp',union);
 const reverse=names.currentNames('クラウド、行こう。',"Let's go.",catalog);names.validateNames('走吧。',"Let's go.",'en',reverse);
 assert.equal(names.promptNames(reverse,"Let's go.",'en')[0].matched_in_current_source,false);
 assert.equal(names.promptNames(reverse,'クラウド、行こう。','jp')[0].matched_in_current_source,true);
});
function row(){const source='クラウドさん、行こう。';return{stem:'asr-only',text_jp:source,text_en:null,translate_zh_jp:'克劳迪，走吧。',origin:{manual_review_revision:0},manual_review_revision:0,has_marked_audio:false,llm_task:'independent-translation-jp',llm_model:'local27b',llm_status:'success',checkpoints:{translate_jp:{state:'translated',source_text:source,input_hash:hash(source),text:'克劳迪，走吧。',model:'local27b',log_id:'1'}}};}
test('audit queues only untouched machine mistranslations and leaves correct/user-edited/source-changed/manual-marked values alone',()=>{
 const r=row();assert.equal(nameReviewEligibility(r,catalog,'local27b').eligible,true);
 for(const [patch,reason]of [[{translate_zh_jp:'用户自己改过'},'translation-edited'],[{text_jp:'クラウド、别的话'},'source-changed'],[{manual_review_revision:1},'manual-selection-changed-or-present'],[{has_marked_audio:true},'manual-selection-changed-or-present'],[{llm_task:'manual-other-task'},'not-this-pipeline-machine-translation']])assert.equal(nameReviewEligibility({...r,...patch},catalog,'local27b').reason,reason);
 assert.equal(nameReviewEligibility({...r,translate_zh_jp:'克劳德，走吧。'},catalog,'local27b').reason,'already-correct');
});

test('Japanese proper names never match inside longer Katakana words, including NFKC halfwidth forms',()=>{
 const c=names.compileNames({entries:[{english:'Sarah',japanese:'サラ',chinese:'莎拉',english_aliases:['Sarah'],matchable:true},{english:'Sam',japanese:'サム',chinese:'山姆',english_aliases:['Sam'],matchable:true},{english:'Oates',japanese:'ムギ',chinese:'麦子',english_aliases:['Oates'],matchable:true},{english:'Nero',japanese:'ネロ',chinese:'尼禄',english_aliases:['Nero'],matchable:true},cloud]});
 for(const text of ['サラリーマン','サムライ','コムギ','ｻﾗﾘｰﾏﾝ','ｻﾑﾗｲ','ｺﾑｷﾞ','モネロ','クラウドサンダー'])assert.deepEqual(names.currentJapaneseNames(text,c),[],text);
 for(const text of ['クラウドは','クラウドさん','クラウドサンは','ｸﾗｳﾄﾞｻﾝ','サラさん','サムくん','ムギちゃん','ネロは'])assert.equal(names.currentJapaneseNames(text,c).length,1,text);
});

test('verified English aliases are transmitted as the same person and enforce the canonical Chinese name',()=>{
 const entry={english:'Don Corneo',japanese:'コルネオ',chinese:'古留根尾',english_aliases:['Don Corneo','Corneo'],matchable:true};
 const c=names.compileNames({entries:[entry]});
 const hits=names.currentNames(null,'Corneo is waiting.',c),payload=names.promptNames(hits,'Corneo is waiting.','en');
 assert.equal(hits.length,1);assert.deepEqual(payload[0].verified_english_aliases,['Corneo']);assert.equal(payload[0].matched_in_current_source,true);
 assert.equal(payload[0].english,'Don Corneo');assert.equal(payload[0].chinese,'古留根尾');
 assert.throws(()=>names.validateNames('科内奥正在等你。','Corneo is waiting.','en',hits),{code:'translation-name-mismatch'});
 names.validateNames('古留根尾正在等你。','Corneo is waiting.','en',hits);
 const irrelevant=names.promptNames(hits,'行こう。','jp');assert.equal(irrelevant[0].matched_in_current_source,false);names.validateNames('走吧。','行こう。','jp',hits);
});

test('model-visible glossary spells out the verified source alias to official Chinese mapping and never forces an absent source name',()=>{
 const c=names.compileNames({entries:[{english:'Don Corneo',japanese:'コルネオ',chinese:'古留根尾',english_aliases:['Don Corneo','Corneo'],matchable:true}]});
 const selected=names.currentNames(null,'The Corneo Cup starts now.',c),text=names.nameGlossaryText(selected,'The Corneo Cup starts now.','en');
 assert.ok(text.includes('"verified_english_aliases":["Corneo"]'));assert.ok(text.includes('"Corneo" → "古留根尾"'));assert.match(text,/复合名称.*不能重新音译/);
 const unrelated=names.nameGlossaryText(selected,'行こう。','jp');assert.ok(!unrelated.includes('"Corneo" →'));assert.match(unrelated,/当前待译原文没有命中的姓名/);assert.ok(unrelated.includes('"matched_in_current_source":false'));
});
