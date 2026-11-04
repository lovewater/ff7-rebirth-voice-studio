/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript'),crypto=require('node:crypto');
const m=new Module(__filename);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/model-chinese-script.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
const {modelChineseScript:plan,modelChineseSourceUnchanged:unchanged}=m.exports;
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function fixture(){const row={stem:'TEST',text_zh:'',text_jp:'ふん。',text_en:'',translate_zh_jp:'哼。',translate_zh_en:null,extra:{game_id:'remake',audio_sources:{jp:{clip:{audio_path:'jp/TEST.mp3',mp3_sha256:'a'.repeat(64)}}},remake_preprocess:{asr:{event_id:'1',text_jp_filled:true},translate_jp:{event_id:'2'}}}};const events=[{id:'1',stem:'TEST',stage:'asr',input_hash:'a'.repeat(64),evidence:{state:'recognized',language:'Japanese',text:'ふん。',source_sha256:'a'.repeat(64)}},{id:'2',stem:'TEST',stage:'translate_jp',input_hash:hash('ふん。'),evidence:{state:'translated',source_text:'ふん。',text:'哼。',model:'local27b'}}];return {row,events};}
test('empty official Chinese can use a completed ASR-linked model translation without writing or inventing original Chinese',()=>{
 const {row,events}=fixture(),before=JSON.stringify(row),source=plan(row,events);assert.equal(source.kind,'model-translation');assert.equal(source.translation,'哼。');assert.equal(source.originalChinese,'');assert.equal(source.asrEventId,'1');assert.equal(JSON.stringify(row),before);assert.equal(unchanged(source,row),true);
});
test('nonempty human/official Chinese wins over reference translations',()=>{
 const {row,events}=fixture();assert.equal(plan({...row,text_zh:'人工中文'},events),null);
});
for(const edit of ['source-text','translation-text','event-hash','wrong-stem','asr-audio-sha','missing-event'])test(`model translation rejects ${edit} evidence`,()=>{
 const {row,events}=fixture();if(edit==='source-text')row.text_jp='別の文章';if(edit==='translation-text')row.translate_zh_jp='人工参考改动';if(edit==='event-hash')events[1].input_hash='bad';if(edit==='wrong-stem')events[1].stem='OTHER';if(edit==='asr-audio-sha')events[0].evidence.source_sha256='bad';if(edit==='missing-event')events.pop();assert.equal(plan(row,events),null);
});
test('an original Chinese or reference/source edit during generation invalidates final source binding',()=>{
 const {row,events}=fixture(),source=plan(row,events);for(const change of [{text_zh:'后来手填中文'},{translate_zh_jp:'另译'},{text_jp:'別文'}])assert.equal(unchanged(source,{...row,...change}),false);
});
test('English fallback requires a verified same-asset audio pairing and its own matching translation event',()=>{
 const {row}=fixture();row.text_jp='';row.translate_zh_jp=null;row.text_en='Come here.';row.translate_zh_en='过来。';row.extra.audio_sources.en={clip:{audio_path:'en/TEST.mp3',mp3_sha256:'b'.repeat(64)}};row.extra.remake_preprocess.translate_en={event_id:'3'};
 const events=[{id:'3',stem:'TEST',stage:'translate_en',input_hash:hash(row.text_en),evidence:{state:'translated',source_text:row.text_en,text:row.translate_zh_en,model:'local27b'}}];assert.equal(plan(row,events),null);row.extra.english_pairing={status:'same-single-asset',en_audio_path:'en/TEST.mp3'};assert.equal(plan(row,events).language,'en');
});
