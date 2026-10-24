/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const {rewriteContextChinese}=require('./rewrite-context.ts');

test('锁定中文成为前后文主参考，同时保留原中文和内部换行',()=>{
 assert.deepEqual(rewriteContextChinese('旧字幕','  改写第一行\n第二行  '),{textZh:'改写第一行\n第二行',lockedZh:'改写第一行\n第二行',originalTextZh:'旧字幕'});
 for(const locked of [null,undefined,'','  '])assert.deepEqual(rewriteContextChinese('原中文',locked),{textZh:'原中文',lockedZh:null,originalTextZh:'原中文'});
 assert.equal(rewriteContextChinese(null,'新稿').textZh,'新稿');
});

function load(file,overrides,append=''){
 const m=new Module(__filename);m.require=id=>overrides[id]??(id==='./rewrite-context'?{rewriteContextChinese}:id.startsWith('node:')?require(id):{});
 m._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/${file}`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText+append,`${__dirname}/${file}`);return m.exports;
}

test('自动改稿只读ready且locked的邻句，当前稿及原始三语不被覆盖',async()=>{
 const rows=[{stem:'before',name_zh:'蒂法',text_zh:'原上句',subtitle_text:'锁定上句',text_jp:'前',text_en:'before',dialogue_mode:'scene'},
  {stem:'current',text_zh:'本句原稿',subtitle_text:'本句旧锁定稿',text_jp:'今',text_en:'now',dialogue_mode:'scene'},
  {stem:'after',text_zh:'原下句',subtitle_text:null,text_jp:'後',text_en:'after',dialogue_mode:'scene'}];
 const queries=[],measurements=[];const sql=async(parts)=>{queries.push(parts.join('?'));return rows;};
 const compiled=load('auto-run.ts',{'./db':{sql},'test-measure':(jp,cn)=>measurements.push({jp,cn}),'./rewrite-prompt':{samePerformance:()=>true,takeUntilBoundary:(r,i)=>({before:r.slice(0,i),after:r.slice(i+1)})}},
  '\nexports.testLoadContext=loadRewriteContext;countBeats=async(jp,cn)=>{require("test-measure")(jp,cn);return {}};');
 const result=await compiled.testLoadContext('current','本轮当前稿');
 assert.equal(result.before[0].textZh,'锁定上句');assert.equal(result.before[0].originalTextZh,'原上句');
 assert.equal(result.after[0].textZh,'原下句');assert.equal(result.line.text_zh,'本句原稿');
 assert.deepEqual(measurements,[{jp:'今',cn:'本轮当前稿'}]);
 assert.match(queries[0],/LATERAL/);assert.match(queries[0],/review_state\s*=\s*'locked'/);assert.match(queries[0],/status\s*=\s*'ready'/);
 assert.match(queries[0],/NULLIF\(BTRIM\(v\.subtitle_text\)/);assert.match(queries[0],/l\.text_zh/);assert.doesNotMatch(queries[0],/BTRIM\(v\.(?:tts_text|spoken_text)\)/);
});


test('历史反馈和正常语速改稿JSON均用锁定中文，本句原稿和本轮稿独立保留',()=>{
 const api=load('rewrite-prompt.ts',{});
 const before={speaker:'蒂法',textJp:'前',textEn:'before',textZh:'旧上句',lockedZh:'锁定上句'};
 const input={speaker:'克劳德',show:'同一演出',textJp:'今',textEn:'now',original:'本句原中文',current:'本轮当前稿',beats:{jp:{units:2},cn:{units:2}},before:[before],after:[],previous:[]};
 for(const mode of [{attemptHistoryMode:true},{normalSpeedLine:{candidateId:'1',script:'当前稿',rate:6.5,netSeconds:1,referenceSeconds:1,candidateSeconds:1}}]){
  const messages=api.rewriteMessages({...input,...mode});
  const payload=JSON.parse(messages[1].promptValues.input_json);
  assert.equal(payload.before[0].textZh,'锁定上句');assert.equal(payload.before[0].originalTextZh,'旧上句');
  assert.equal(payload.originalChinese,'本句原中文');assert.equal(payload.current,'本轮当前稿');
 }
 assert.equal(before.textZh,'旧上句');
});

test('文字格式上下文也以锁定中文为主并标出原稿',()=>{
 const api=load('rewrite-prompt.ts',{},'\nexports.testShow=showLine;');
 const text=api.testShow(1,'前',{speaker:'蒂法',textJp:'前',textEn:'before',textZh:'旧上句',lockedZh:'锁定上句'});
 assert.match(text,/中（锁定稿）：锁定上句/);assert.match(text,/原中文：旧上句/);
});

test('手动改稿使用同一上下文中文规则，不改原始日英文',()=>{
 const api=load('../app/api/lines/[stem]/rewrite/route.ts',{'@/lib/rewrite-context':{rewriteContextChinese}},'\nexports.testShow=showLine;');
 const result=api.testShow({name_zh:'蒂法',text_jp:'前',text_en:'before',text_zh:'旧上句',subtitle_text:'锁定上句'});
 assert.equal(result.textZh,'锁定上句');assert.equal(result.originalTextZh,'旧上句');assert.equal(result.textJp,'前');assert.equal(result.textEn,'before');
});
