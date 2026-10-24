/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const original='就算是伙伴\n我们塔克斯，有时也必须无情地舍弃',expected='就算是伙伴我们塔克斯\n有时也必须无情地舍弃';
function setup(options={}){const state={subtitle:original,review:'candidate',calls:0,transaction:false,queries:[]},cache=new Map();
 const sql=async(strings,...values)=>{const q=strings.join('?');state.queries.push(q);
  if(q.includes(' AS japanese'))return[{japanese:'原文',chinese:state.subtitle??original}];
  if(q.includes(' AS text'))return state.review==='candidate'?[{text:state.subtitle??original,source:options.source}]:[];
  if(q.includes('UPDATE line_tts_versions v SET subtitle_text')){if(options.manual){state.subtitle='人工已经改好的字幕';state.review='locked';}if(state.review!=='candidate'||state.subtitle!==original)return[];state.subtitle=values[0];return[{id:'123'}];}
  if(q.includes('SELECT stem FROM line_auto_runs'))return[{stem:'test'}];
  if(q.includes(' AS original_subtitle'))return[{id:'123',review_state:state.review,subtitle_text:state.subtitle,original_subtitle:options.originalText??original}];
  if(q.includes('UPDATE line_tts_versions SET subtitle_text'))state.subtitle=values[0];
  return[];
 };sql.json=x=>x;sql.begin=async fn=>{state.transaction=true;try{return await fn(sql);}finally{state.transaction=false;}};
 function load(file){if(cache.has(file))return cache.get(file).exports;const m=new Module(file);cache.set(file,m);m.require=id=>{
  if(id==='./auto-run-model-policy')return{captureAutoRunOutcome:()=>false};
  if(id.startsWith('node:'))return require(id);
  if(id==='./db')return{sql};
  if(id==='./subtitle-quotes')return{needsSubtitleQuotes:()=>false};
  if(id==='./llm-metrics')return{llmMetricsForRun:async()=>({tokens:null,speed:null})};
  if(id==='./auto-run-llm')return{rewriteChat:async()=>{state.calls++;throw Error('layout must not call a model');}};
  if(['./auto-run-subtitle-format','./auto-run-subtitle','./subtitle-reflow','./final-auto-subtitle'].includes(id))return load(path.resolve(path.dirname(file),id+'.ts'));
  return{};
 };m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText+(file.endsWith('/auto-run.ts')?'\nexports.testFinish=finish;':''),file);return m.exports;}
 return{state,finish:()=>load(__dirname+'/auto-run.ts').testFinish('run','passed',null,'123')};
}
test('final selection restores original after layout-only changes',async()=>{const c=setup();await c.finish();assert.equal(c.state.calls,0);assert.equal(c.state.subtitle,null);assert.ok(!c.state.queries.some(q=>q.includes('SET tts_text')));});
test('subtitle reflow never overwrites manual changes made while model formats it',async()=>{const c=setup({manual:true});await c.finish();assert.equal(c.state.subtitle,'人工已经改好的字幕');});
test('model unavailable cannot block local formatting',async()=>{const c=setup({fail:true});await c.finish();assert.equal(c.state.subtitle,null);assert.equal(c.state.calls,0);});

test('actual finish recovers raw-script punctuation before moving a temporary break',async()=>{
 const c=setup({source:'就算是伙伴。我们塔克斯，有时也必须无情地舍弃'});await c.finish();
 assert.equal(c.state.subtitle,null);assert.equal(c.state.calls,0);
});

test('real wording changes still retain their locally reflowed subtitle',async()=>{
 const c=setup({originalText:'就算是朋友，我们塔克斯有时也必须无情地舍弃'});await c.finish();
 assert.equal(c.state.subtitle,expected);assert.equal(c.state.calls,0);
});
