/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function setup(changed){let outcome;const queries=[];
 const current={text_zh:changed?'人工新原稿':'原稿',text_jp:'日本語',text_en:'English',translate_zh_jp:'日译中',translate_zh_en:'英译中'};
 const sql=async(parts,...values)=>{const q=parts.join('?');queries.push(q);
  if(q.includes('SELECT stem FROM line_auto_runs')||q.includes('SELECT stem FROM lines'))return[{stem:'line'}];
  if(q.includes('SELECT text_zh,text_jp,text_en,translate_zh_jp,translate_zh_en'))return[current];
  if(q.includes('SELECT v.id::text, v.review_state'))return[{id:'qualified',review_state:'candidate',subtitle_text:null,original_subtitle:'原稿'}];
  if(q.includes('UPDATE line_auto_runs SET status'))outcome=values;
  return[];
 };sql.json=x=>x;sql.begin=fn=>fn(sql);
 const m=new Module(__filename);m.require=id=>id==='./auto-run-stage-context'?require('./auto-run-stage-context.ts'):id==='./db'?{sql}:id==='./auto-run-model-policy'?{captureAutoRunOutcome:()=>false}:id==='./llm-metrics'?{llmMetricsForRun:async()=>({tokens:null,speed:null})}:id.startsWith('node:')?require(id):{};
 m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/auto-run.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText+'\nexports.testFinish=finish;',__dirname+'/auto-run.ts');
 return {api:m.exports,queries,get outcome(){return outcome;}};
}
for(const changed of [false,true])test(`qualified optimization final transaction ${changed?'preserves intervening source edits without recommending old audio':'retains an unchanged source and selected final'}`,async()=>{
 const h=setup(changed);await h.api.testFinish('run','passed',null,'qualified',{preserveSubtitle:true,guardManualStem:true,expectedSource:{textZh:'原稿',textJp:'日本語',textEn:'English',translateZhJp:'日译中',translateZhEn:'英译中'}});
 assert.equal(h.outcome[0],changed?'failed':'passed');assert.equal(h.outcome[2],changed?null:'qualified');assert.ok(h.queries.some(q=>q.includes('SELECT text_zh,text_jp')&&q.includes('FOR UPDATE')));
});
