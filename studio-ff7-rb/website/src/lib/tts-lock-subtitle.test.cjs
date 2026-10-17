/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {needsLockSubtitleConfirmation:needs}=require('./tts-lock-subtitle.ts');
const base={isAutoFinal:false,isJapaneseOriginal:false,subtitle:null,ttsText:'就算你后悔也来不及了！',original:'哼，就算你后悔也来不及了！'};
test('final automatic audio inheriting original caption must not propose its body-only TTS text',()=>{
 assert.equal(needs({...base,isAutoFinal:true}),false);
 assert.equal(needs({...base,isAutoFinal:true,original:'嘿嘿，那么就这么说定了！',ttsText:'那么就这么说定了！'}),false);
});
test('unconfirmed manual synthesis still asks about genuine subtitle changes',()=>{
 assert.equal(needs(base),true);
 assert.equal(needs({...base,subtitle:'哼，就算你后悔也来不及了！'}),false);
});
test('automatic child is not implicitly a final audio; original Japanese locks need no rewrite',()=>{
 assert.equal(needs({...base,isAutoFinal:false}),true);
 assert.equal(needs({...base,isJapaneseOriginal:true}),false);
});
test('punctuation, pause commands and line layout alone do not trigger manual subtitle confirmation',()=>{
 assert.equal(needs({...base,ttsText:'哼[停顿=200]，就算你后悔\\n也来不及了。'}),false);
});

// 直接执行锁定PATCH，验证自动成品不会409或写入去拟声字幕，手动差异仍在任何写入前中止。
function lockRoute(isAutoFinal) {
 const Module=require('node:module'),ts=require('typescript'),fs=require('node:fs');
 const writes=[],queries=[];
 const sql=async(parts)=>{const q=parts.join('?');queries.push(q);
  if(q.includes('FOR UPDATE'))return[{id:39499,tts_text:base.ttsText,subtitle_text:null,is_used:false,is_jp_lock:false,is_auto_final:isAutoFinal}];
  if(q.includes('SELECT text_zh'))return[{text_zh:base.original}];
  if(q.includes('UPDATE line_tts_versions')){writes.push(q);return q.includes('RETURNING')?[{id:39499,is_used:true,subtitle_text:null}]:[];}
  return[];
 };sql.begin=fn=>fn(sql);
 const file=__dirname+'/../app/api/lines/[stem]/tts/[id]/route.ts',m=new Module(file);
 m.require=id=>{
  if(id.startsWith('node:'))return require(id);
  if(id==='next/server')return{NextResponse:{json:(body,options)=>({status:options?.status||200,body})}};
  if(id==='@/lib/db')return{sql};
  if(id==='@/lib/auto-run-subtitle')return require('./auto-run-subtitle.ts');
  if(id==='@/lib/tts-lock-subtitle')return require('./tts-lock-subtitle.ts');
  return{};
 };
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
 return{writes,queries,patch:()=>m.exports.PATCH({json:async()=>({isUsed:true})},{params:Promise.resolve({stem:'CHADL_QST_01_1800_1200_00_beg',id:'39499'})})};
}
test('locking final #39499 succeeds while keeping NULL subtitle inheritance and full original 哼',async()=>{
 const r=lockRoute(true),response=await r.patch();assert.equal(response.status,200);assert.equal(response.body.record.subtitle_text,null);assert.equal(r.writes.length,2);assert.ok(r.writes.every(q=>!q.includes('subtitle_text =')));assert.match(r.queries[0],/ar.selected_tts_id = line_tts_versions.id/);
});
test('manual body-only audio still requires subtitle confirmation before touching any lock',async()=>{
 const r=lockRoute(false),response=await r.patch();assert.equal(response.status,409);assert.equal(response.body.code,'SUBTITLE_CONFIRMATION_REQUIRED');assert.equal(response.body.subtitleText,base.ttsText);assert.equal(r.writes.length,0);
});
