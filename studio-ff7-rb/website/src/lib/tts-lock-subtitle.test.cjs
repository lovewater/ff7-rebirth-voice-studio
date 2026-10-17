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
function lockRoute(isAutoFinal, options={}) {
 const Module=require('node:module'),ts=require('typescript'),fs=require('node:fs');
 const writes=[],queries=[],formatted=[];
 let inTransaction=false;
 const sql=async(parts)=>{const q=parts.join('?');queries.push(q);
  if(q.includes('FOR UPDATE'))return[{id:39499,tts_text:options.draft??base.ttsText,subtitle_text:options.subtitle??null,review_state:"candidate",is_jp_lock:options.jp??false,is_auto_final:isAutoFinal}];
  if(q.includes('SELECT text_zh'))return[{text_zh:options.original??base.original}];
  if(q.includes('UPDATE line_tts_versions')){writes.push(q);return q.includes('RETURNING')?[{id:39499,review_state:"locked",subtitle_text:null}]:[];}
  return[];
 };sql.begin=async fn=>{inTransaction=true;try{return await fn(sql);}finally{inTransaction=false;}};
 const file=__dirname+'/../app/api/lines/[stem]/tts/[id]/route.ts',m=new Module(file);
 m.require=id=>{
  if(id.startsWith('node:'))return require(id);
  if(id==='next/server')return{NextResponse:{json:(body,options)=>({status:options?.status||200,body})}};
  if(id==='@/lib/db')return{sql};
  if(id==='@/lib/tts-review-state')return require('./tts-review-state.ts');
  if(id==='@/lib/auto-run-subtitle')return require('./auto-run-subtitle.ts');
  if(id==='@/lib/final-auto-subtitle')return require('./final-auto-subtitle.ts');
  if(id==='@/lib/auto-run-subtitle-format')return{createAutoRunSubtitleFormatter:()=>async draft=>{
   assert.equal(inTransaction,false,'model-backed formatting must run after transaction rollback');
   formatted.push(draft);
   if(options.formatError)throw Error('layout unavailable');
   return options.formatted??require('./auto-run-subtitle.ts').autoRunSubtitle(draft);
  }};
  if(id==='@/lib/tts-lock-subtitle')return require('./tts-lock-subtitle.ts');
  return{};
 };
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
 return{writes,queries,formatted,patch:()=>m.exports.PATCH({json:async()=>({reviewState:"locked",...options.body})},{params:Promise.resolve({stem:'CHADL_QST_01_1800_1200_00_beg',id:'39499'})})};
}
test('locking final #39499 succeeds while keeping NULL subtitle inheritance and full original 哼',async()=>{
 const r=lockRoute(true),response=await r.patch();assert.equal(response.status,200);assert.equal(response.body.record.subtitle_text,null);assert.equal(r.writes.length,2);assert.ok(r.writes.every(q=>!q.includes('subtitle_text =')));assert.ok(r.queries.some(q=>q.includes('ar.selected_tts_id = line_tts_versions.id')));
});
test('manual body-only audio still requires subtitle confirmation before touching any lock',async()=>{
 const r=lockRoute(false),response=await r.patch();assert.equal(response.status,409);assert.equal(response.body.code,'SUBTITLE_CONFIRMATION_REQUIRED');assert.equal(response.body.subtitleText,base.ttsText);assert.equal(r.writes.length,0);
});
test('lock confirmation prefills a short merged subtitle without changing the audio or any lock',async()=>{
 const r=lockRoute(false,{draft:'我，\n不要被吃啊！',original:'我不想被吃掉啊！'}),response=await r.patch();
 assert.equal(response.status,409);assert.equal(response.body.subtitleText,'我，不要被吃啊！');
 assert.equal(r.formatted.length,1);assert.equal(r.writes.length,0);
});
test('lock confirmation cleans commas at existing line breaks and preserves inner punctuation',async()=>{
 const r=lockRoute(false,{draft:'在过去的训练数据中，\n确认到了相应的序号。难道说，你是塔……'}),response=await r.patch();
 assert.equal(response.body.subtitleText,'在过去的训练数据中\n确认到了相应的序号。难道说，你是塔……');
 assert.equal(r.writes.length,0);
});
test('semantic line breaks are prepared before confirmation, outside the write transaction',async()=>{
 const r=lockRoute(false,{draft:'我们一定要赶在天黑之前找到通往村庄的道路',formatted:'我们一定要赶在天黑之前\n找到通往村庄的道路'}),response=await r.patch();
 assert.equal(response.body.subtitleText,'我们一定要赶在天黑之前\n找到通往村庄的道路');
 assert.equal(r.formatted.length,1);assert.equal(r.writes.length,0);
});
test('layout failure still allows manual confirmation of the unmodified wording with a visible notice',async()=>{
 const draft='我们一定要赶在天黑之前找到通往村庄的道路';
 const r=lockRoute(false,{draft,formatError:true}),response=await r.patch();
 assert.equal(response.status,409);assert.equal(response.body.subtitleText,draft);
 assert.match(response.body.subtitlePreparationError,/检查字幕分行/);assert.equal(r.writes.length,0);
});

test('abnormal-page lock always requires confirmation even for unchanged automatic final, with full original interjection',async()=>{
 const r=lockRoute(true,{body:{requireSubtitleConfirmation:true}}),response=await r.patch();
 assert.equal(response.status,409);assert.equal(response.body.subtitleText,base.original);assert.equal(r.writes.length,0);
});
test('abnormal-page lock prefills existing subtitle and also requires confirmation for Japanese original',async()=>{
 const r=lockRoute(true,{jp:true,subtitle:'嘿嘿，正确答案！',body:{requireSubtitleConfirmation:true}}),response=await r.patch();
 assert.equal(response.status,409);assert.equal(response.body.subtitleText,'嘿嘿，正确答案！');assert.equal(r.writes.length,0);
});
test('confirmed abnormal-page subtitle can lock atomically instead of asking again',async()=>{
 const r=lockRoute(true,{body:{requireSubtitleConfirmation:true,subtitleText:base.original}}),response=await r.patch();
 assert.equal(response.status,200);assert.equal(r.writes.length,2);assert.ok(r.writes.some(q=>q.includes('subtitle_text =')));
});

test('mandatory review keeps the existing manual rewrite proposal instead of replacing it with original',async()=>{
 const r=lockRoute(false,{body:{requireSubtitleConfirmation:true}}),response=await r.patch();
 assert.equal(response.status,409);assert.equal(response.body.subtitleText,base.ttsText);assert.equal(r.writes.length,0);
});
