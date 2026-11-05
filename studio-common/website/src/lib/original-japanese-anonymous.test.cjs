/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function setup(marked=false){const queries=[];let copied;
 const original=Buffer.from('unchanged original mp3 bytes'),sql=async(parts,...values)=>{
  const q=parts.join('?');queries.push({q,values});
  if(q.includes('INSERT INTO line_tts_versions')){assert.equal(values[2],null);assert.ok(values.includes('jp-lock'));return[{id:'81'}];}
  if(q.includes("review_state IN ('locked','abnormal')"))return marked?[{id:'old'}]:[];
  return [];
 };sql.json=x=>x;sql.begin=fn=>fn(sql);
 const m=new Module(__filename);m.require=id=>{
  if(id==='./db')return{sql};
  if(id==='node:fs/promises')return{mkdir:async()=>{},writeFile:async(p,b)=>{copied={p,b};},readFile:async()=>original};
  if(id==='./auto-run-subtitle')return{twoLineSubtitle:x=>x};
  if(id==='./pure-interjection')return require('./pure-interjection.ts');
  if(id==='./shushu-emotion')return{pureShushuOriginal:()=>false};
  if(id==='./auto-run-stage-context')return{currentAutoRunStage:()=>null};
  if(id.startsWith('node:'))return require(id);
  return{};
 };
 m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/auto-run.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText+'\nfinish=async(...args)=>exports.finished.push(args);exports.finished=[];exports.testHooks={runOriginalJapanese,finishWholeNonverbalFirst};',__filename);
 return{api:m.exports.testHooks,finished:m.exports.finished,queries,original,get copied(){return copied;}};
}
const line={stem:'group_test',speaker:null,text_zh:'哈哈……',text_jp:'ははは',text_en:null};
test('匿名纯拟声在场景和普通流程第一步均保存原始字节并实际锁定，不需要人物或推理',async()=>{
 for(const workflow of ['performance','casual']){
  const c=setup();assert.equal(await c.api.finishWholeNonverbalFirst('7',line,workflow),true);
  assert.deepEqual(c.copied.b,c.original);assert.equal(c.queries.filter(x=>x.q.includes("SET review_state='locked'")).length,1);
  assert.equal(c.finished[0][1],'passed');assert.equal(c.finished[0][3],'81');
  assert.ok(c.queries.some(x=>x.q.includes('UPDATE line_tts_versions v SET status')));
 }
});
test('匿名原声遇到人工选择仍保留人工，不自动替换',async()=>{
 const c=setup(true);await c.api.finishWholeNonverbalFirst('7',line,'performance');
 assert.equal(c.queries.some(x=>x.q.includes("SET review_state='locked'")),false);
 assert.equal(c.finished[0][1],'failed');assert.equal(c.finished[0][3],null);
});
test('Seed空不等于纯拟声：未确认分支只保存候选，不因修复NULL人物而盲锁',async()=>{
 const c=setup();await c.api.runOriginalJapanese('7',{...line,text_zh:'怎么样。'},c.original,{workflow:'seed-empty-original',reason:'Seed empty'});
 assert.equal(c.queries.some(x=>x.q.includes("SET review_state='locked'")),false);assert.deepEqual(c.copied.b,c.original);
});
test('有正文的匿名条目不会被纯拟声规则吞掉',async()=>{
 const c=setup();assert.equal(await c.api.finishWholeNonverbalFirst('7',{...line,text_zh:'怎么样。'},'performance'),false);assert.equal(c.copied,undefined);
});
