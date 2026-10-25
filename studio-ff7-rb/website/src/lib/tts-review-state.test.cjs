/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {isTtsReviewState:valid,nextTtsReviewState:next}=require('./tts-review-state.ts');
test('three review states are explicit; booleans and generation states are rejected',()=>{
 for(const s of ['candidate','locked','abnormal'])assert.equal(valid(s),true);
 for(const s of [true,false,null,undefined,'ready','failed','building',''])assert.equal(valid(s),false);
});
test('new lock or abnormal clears the previous human decision',()=>{
 assert.equal(next('locked',false,'locked'),'candidate');
 assert.equal(next('abnormal',false,'locked'),'candidate');
 assert.equal(next('candidate',false,'locked'),'candidate');
 assert.equal(next('locked',false,'abnormal'),'candidate');
 assert.equal(next('abnormal',false,'abnormal'),'candidate');
 assert.equal(next('abnormal',false,'candidate'),'abnormal');
 assert.equal(next('locked',true,'abnormal'),'abnormal');
 assert.equal(next('abnormal',true,'candidate'),'candidate');
 assert.equal(next('abnormal',true,'locked'),'locked');
});

const fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function route(){
 const rows=[{id:1,review_state:'locked'},{id:2,review_state:'candidate'},{id:3,review_state:'abnormal'}]
  .map(r=>({...r,tts_text:'同一句',subtitle_text:'同一句',used_at:r.review_state==='locked'?'before':null,is_jp_lock:false,is_auto_final:false}));
 let writes=0;
 const sql=async(parts,...args)=>{
  const q=parts.join('?');
  if(q.includes('SELECT stem FROM lines'))return[{stem:'TEST'}];
  if(q.includes('SELECT id, tts_text'))return rows.filter(r=>r.id===args[0]);
  if(q.includes("SET review_state = 'candidate'")){
   writes++;for(const r of rows)if(r.review_state!=='candidate'){r.review_state='candidate';r.used_at=null;}return[];
  }
  if(q.includes('UPDATE line_tts_versions SET')&&q.includes('RETURNING')){
   writes++;const r=rows.find(r=>r.id===args.at(-1));r.review_state=args[0];r.used_at=args[0]==='locked'?'now':null;return[r];
  }
  return[];
 };sql.begin=fn=>fn(sql);
 const file=__dirname+'/../app/api/lines/[stem]/tts/[id]/route.ts',m=new Module(file);
 m.require=id=>{
  if(id.startsWith('node:'))return require(id);
  if(id==='@/lib/inline-pinyin')return require('./inline-pinyin.ts');
  if(id==='next/server')return{NextResponse:{json:(body,options)=>({status:options?.status??200,body})}};
  if(id==='@/lib/db')return{sql};
  if(id==='@/lib/tts-review-state')return require('./tts-review-state.ts');
  return{};
 };
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
 return{rows,writes:()=>writes,patch:(id,body)=>m.exports.PATCH({json:async()=>body},{params:Promise.resolve({stem:'TEST',id:String(id)})})};
}
test('PATCH keeps exactly one human choice, including switching from lock to abnormal',async()=>{
 const r=route();assert.equal((await r.patch(2,{reviewState:'locked'})).status,200);
 assert.deepEqual(r.rows.map(v=>v.review_state),['candidate','locked','candidate']);
 assert.equal((await r.patch(2,{reviewState:'abnormal'})).status,200);
 assert.deepEqual(r.rows.map(v=>v.review_state),['candidate','abnormal','candidate']);
 assert.equal(r.rows[1].used_at,null);
 assert.equal((await r.patch(2,{reviewState:'candidate'})).status,200);
 assert.equal(r.rows[1].review_state,'candidate');
});
test('PATCH rejects invalid states without touching locks',async()=>{
 for(const reviewState of [true,false,null,'ready','failed',1]){
  const r=route();assert.equal((await r.patch(2,{reviewState})).status,400);assert.equal(r.writes(),0);
 }
 for(const body of [null,[],{}]){
  const r=route();assert.equal((await r.patch(2,body)).status,400);assert.equal(r.writes(),0);
 }
});

test('手机只读锁定沿用现有字幕，不进入字幕编辑确认',async()=>{
 const r=route();r.rows[1].tts_text='新的朗读台词';r.rows[1].subtitle_text=null;
 const result=await r.patch(2,{reviewState:'locked',preserveSubtitle:true,requireSubtitleConfirmation:true});
 assert.equal(result.status,200);assert.equal(r.rows[1].review_state,'locked');assert.equal(r.rows[1].subtitle_text,null);
});
test('沿用字幕与修改字幕不能同时请求，取消时不改变人工状态',async()=>{
 const r=route();const result=await r.patch(2,{reviewState:'locked',preserveSubtitle:true,subtitleText:'修改的字幕'});
 assert.equal(result.status,400);assert.equal(r.writes(),0);
});
