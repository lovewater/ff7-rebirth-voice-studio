/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const outerModule=require('node:module'),outerTs=require('typescript'),outerFs=require('node:fs');
const lockPolicy=new outerModule(__filename);lockPolicy.require=id=>require(id+'.ts');
lockPolicy._compile(outerTs.transpileModule(outerFs.readFileSync(__dirname+'/tts-lock-subtitle.ts','utf8'),{compilerOptions:{module:outerTs.ModuleKind.CommonJS,target:outerTs.ScriptTarget.ES2022}}).outputText,__filename);
const {needsLockSubtitleConfirmation:needs}=lockPolicy.exports;
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
  if(id==='@/lib/inline-pinyin')return require('./inline-pinyin.ts');
  if(id==='next/server')return{NextResponse:{json:(body,options)=>({status:options?.status||200,body})}};
  if(id==='@/lib/subtitle-reflow'){
   const file=__dirname+'/subtitle-reflow.ts',reflowModule=new Module(file);reflowModule.require=id=>require(id+'.ts');
   reflowModule._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return reflowModule.exports;
  }
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
  if(id==='@/lib/tts-lock-subtitle')return lockPolicy.exports;
  return{};
 };
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
 return{writes,queries,formatted,patch:()=>m.exports.PATCH({json:async()=>({reviewState:"locked",...options.body})},{params:Promise.resolve({stem:'CHADL_QST_01_1800_1200_00_beg',id:'39499'})})};
}
test('locking final #39499 succeeds while keeping NULL subtitle inheritance and full original 哼',async()=>{
 const r=lockRoute(true),response=await r.patch();assert.equal(response.status,200);assert.equal(response.body.record.subtitle_text,null);assert.equal(r.writes.length,2);assert.ok(r.writes.every(q=>!q.includes('subtitle_text =')));assert.ok(r.queries.some(q=>q.includes('ar.selected_tts_id = ancestor.id')));
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
 assert.equal(response.body.subtitleText,'在过去的训练数据中\n确认到了相应的序号，难道说，你是塔……');
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


test('save-and-lock confirms an inherited changed subtitle before replacing the old lock',async()=>{
 const r=lockRoute(false,{subtitle:'哼，你哪来的脸说这些话。',body:{confirmSubtitleChanges:true}}),response=await r.patch();
 assert.equal(response.status,409);assert.equal(response.body.subtitleText,'哼，你哪来的脸说这些话');assert.equal(r.writes.length,0);
});
test('save-and-lock completes directly when the inherited subtitle matches the original',async()=>{
 const r=lockRoute(false,{subtitle:base.original,body:{confirmSubtitleChanges:true}}),response=await r.patch();
 assert.equal(response.status,200);assert.equal(r.writes.length,2);assert.equal(r.formatted.length,0);
});
test('save-and-lock keeps an unchanged original caption without a confirmation dialog',async()=>{
 const r=lockRoute(false,{draft:base.original,body:{confirmSubtitleChanges:true}}),response=await r.patch();
 assert.equal(response.status,200);assert.equal(r.formatted.length,0);
});
test('save-and-lock confirms a manual rewrite then updates subtitle and lock together',async()=>{
 const pending=lockRoute(false,{body:{confirmSubtitleChanges:true}});assert.equal((await pending.patch()).status,409);assert.equal(pending.writes.length,0);
 const confirmed=lockRoute(false,{body:{confirmSubtitleChanges:true,subtitleText:base.ttsText}});assert.equal((await confirmed.patch()).status,200);assert.equal(confirmed.writes.length,2);assert.ok(confirmed.writes.some(q=>q.includes('subtitle_text =')));
});


test('subtitle confirmation restores original when a new layout has identical words',async()=>{
 const source='就算是伙伴\n我们塔克斯，有时也必须无情地舍弃';
 const formatted='就算是伙伴我们塔克斯\n有时也必须无情地舍弃';
 const r=lockRoute(false,{subtitle:source,original:source,formatted,body:{requireSubtitleConfirmation:true}}),response=await r.patch();
 assert.equal(response.status,409);assert.equal(response.body.subtitleText,source);assert.equal(r.formatted[0],'就算是伙伴我们塔克斯，有时也必须无情地舍弃');assert.equal(r.writes.length,0);
});

test('mandatory confirmation uses original piano caption verbatim after punctuation-only edits',async()=>{
 const original='比小时候弹得好多了。';
 const r=lockRoute(true,{subtitle:'比小时候弹得，好多了',original,body:{requireSubtitleConfirmation:true}}),response=await r.patch();
 assert.equal(response.status,409);assert.equal(response.body.subtitleText,original);assert.equal(r.writes.length,0);
});

test('audio edit derived from final #67635 inherits 嗯 instead of proposing its body at save-and-lock',async()=>{
 const r=lockRoute(true,{draft:'你说得对',original:'嗯，你说得对',body:{confirmSubtitleChanges:true}}),response=await r.patch();
 assert.equal(response.status,200);assert.equal(response.body.record.subtitle_text,null);assert.equal(r.formatted.length,0);
 assert.ok(r.writes.every(q=>!q.includes('subtitle_text =')));
 const query=r.queries.find(q=>q.includes('WITH RECURSIVE lineage'));
 assert.match(query,/parent\.stem = child\.stem/);assert.match(query,/parent\.tts_text IS NOT DISTINCT FROM child\.tts_text/);
 assert.match(query,/parent\.spoken_text IS NOT DISTINCT FROM child\.spoken_text/);
 assert.match(query,/child\.conversion_meta->>'pipeline' = 'audio-edit'/);
 assert.match(query,/NOT parent\.id = ANY\(child\.visited\)/);assert.match(query,/cardinality\(child\.visited\) < 32/);
});
test('mandatory confirmation for a derived final shows full inherited interjection',async()=>{
 const r=lockRoute(true,{draft:'你说得对',original:'嗯，你说得对',body:{requireSubtitleConfirmation:true}}),response=await r.patch();
 assert.equal(response.status,409);assert.equal(response.body.subtitleText,'嗯，你说得对');assert.equal(r.writes.length,0);
});
