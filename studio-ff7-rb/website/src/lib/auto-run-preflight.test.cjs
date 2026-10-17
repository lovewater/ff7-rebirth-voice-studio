/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function compile(file,overrides){const m=new Module(__filename);m.require=id=>overrides[id]??(id.startsWith('./')?{}:require(id));m._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/${file}`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,`${__dirname}/${file}`);return m.exports;}
const normal={id:'7',audio_path:'tts/example.wav',is_used:false,passed:false,start_s:.1,end_s:3.1,dur_s:3.3,speech_s:3,jp_start_s:.1,jp_end_s:3.1,jp_dur_s:3.3,jp_speech_s:3};
function startHarness(rows,extra={}){
 const queries=[];
 const sql=async parts=>{const q=parts.join('?');queries.push(q);
  if(q.includes('SELECT l.stem'))return[{stem:'TEST',dialogue_mode:'scene'}];
  if(q.includes("status = 'running'"))return extra.running?[extra.running]:[];
  if(q.includes('SELECT v.id::text'))return rows;
  if(q.includes('INSERT INTO line_auto_runs'))return[{id:'99'}];
  throw Error('unexpected query '+q);
 };
 const quick=compile('auto-run-quick.ts',{'./timing':compile('timing.ts',{}),'./spoken-text-review':compile('spoken-text-review.ts',{})});
 const api=compile('auto-run.ts',{'./db':{sql},'node:fs/promises':{stat:async()=>{if(extra.missing)throw Error('ENOENT');return{size:100};}},'./auto-run-rules':{isPerformanceMode:()=>true},'./auto-run-quick':quick});
 return{api,queries};
}
test('batch defaults skip existing suitable output without creating a run or changing it',async()=>{
 const {api,queries}=startHarness([normal]);
 assert.deepEqual(await api.startAutoRun('TEST'),{skipped:true,selectedTtsId:'7',reason:'已有时间检查正常的成品'});
 assert.equal(queries.some(q=>q.includes('INSERT')||q.includes('UPDATE')),false);
});
test('human force bypasses suitability and starts full workflow even with a locked result',async()=>{
 const {api,queries}=startHarness([{...normal,is_used:true}]);
 assert.deepEqual(await api.startAutoRun('TEST',{forceGenerate:true}),{skipped:false,id:'99',kind:'performance'});
 assert.equal(queries.some(q=>q.includes('SELECT v.id::text')),false);
});
test('locked or previously passed output is reusable; bad or missing files are not',async()=>{
 for(const row of [{...normal,start_s:null,is_used:true},{...normal,start_s:null,passed:true}])assert.equal((await startHarness([row]).api.startAutoRun('TEST',{forceGenerate:false})).skipped,true);
 assert.equal((await startHarness([{...normal,speech_s:.7}]).api.startAutoRun('TEST')).skipped,false);
 assert.equal((await startHarness([normal],{missing:true}).api.startAutoRun('TEST')).skipped,false);
});
test('force does not override running-job conflict protection',async()=>{
 const {api}=startHarness([normal],{running:{id:'8',updated_at:new Date().toISOString()}});
 await assert.rejects(api.startAutoRun('TEST',{forceGenerate:true}),e=>e.status===409);
});
function routeHarness(result){
 const calls=[],background=[];
 const api=compile('../app/api/lines/[stem]/auto-run/route.ts',{
  'next/server':{NextResponse:{json:(body,options)=>({body,status:options?.status??200})},after:fn=>background.push(fn)},
  '@/lib/auto-run':{startAutoRun:async(...args)=>{calls.push(args);return result;},executeAutoRun:async(...args)=>calls.push(args)}
 });
 return{api,calls,background};
}
test('API validates force boolean, defaults to batch, and never queues work for a skip',async()=>{
 const h=routeHarness({skipped:true,selectedTtsId:'7',reason:'已有结果'}),ctx={params:Promise.resolve({stem:'TEST'})};
 for(const value of ['false',1,null])assert.equal((await h.api.POST({json:async()=>({forceGenerate:value})},ctx)).status,400);
 assert.equal(h.calls.length,0);
 const response=await h.api.POST({json:async()=>({})},ctx);
 assert.equal(response.status,200);assert.equal(response.body.skipped,true);assert.deepEqual(h.calls,[['TEST',{forceGenerate:false}]]);assert.equal(h.background.length,0);
});
test('API passes explicit manual force through to background execution',async()=>{
 const h=routeHarness({skipped:false,id:'99',kind:'performance'});
 const response=await h.api.POST({json:async()=>({forceGenerate:true})},{params:Promise.resolve({stem:'TEST'})});
 assert.equal(response.status,202);await h.background[0]();
 assert.deepEqual(h.calls,[['TEST',{forceGenerate:true}],['99','TEST',{forceGenerate:true}]]);
});

test('first-run quick route generates one batch, reviews once and finishes with recommended candidate',async()=>{
 const line={stem:'TEST',text_zh:'完整台词',text_jp:'日本語',text_en:'English',dialogue_mode:'scene'},events=[],updates=[];
 const sql=async(parts,...args)=>{
  const q=parts.join('?');
  if(q.includes('SELECT l.stem'))return[line];
  if(q.includes('SELECT count(*)::int AS count'))return[{count:0}];
  if(q.includes('SELECT id::text AS id, tts_text'))return['1','2'].map(id=>({id,tts_text:'完整台词',spoken_text:'完整台词',dur_s:3.3,audio_path:`tts/${id}.wav`,speech_pass:true,speech_score:0}));
  if(q.includes('SELECT jp_start_s'))return[{jp_start_s:.1,jp_end_s:3.1,jp_dur_s:3.3,jp_speech_s:3}];
  if(q.includes('FROM pronunciations'))return[];
  if(q.includes('SELECT stem FROM line_auto_runs'))return[{stem:'TEST'}];
  if(q.includes('original_subtitle'))return[{id:'2',subtitle_text:null,original_subtitle:'完整台词'}];
  if(q.includes('INSERT INTO line_auto_run_events'))events.push(args);
  if(q.includes('UPDATE line_auto_runs SET status'))updates.push(args);
  return[];
 };
 sql.json=value=>value;sql.begin=async fn=>fn(sql);
 const quick=compile('auto-run-quick.ts',{'./timing':compile('timing.ts',{}),'./spoken-text-review':compile('spoken-text-review.ts',{})});
 let clones=0,judges=0;
 const originalFetch=global.fetch;
 global.fetch=async(url,options)=>{clones++;assert.match(url,/tts\/clone$/);const body=JSON.parse(options.body);assert.equal(body.ttsText,line.text_zh);assert.equal(body.promptLang,'jp');assert.equal(body.promptPath,undefined);return{ok:true,json:async()=>({ids:['1','2']})};};
 try{
  const api=compile('auto-run.ts',{
   './db':{sql},'node:fs/promises':{readFile:async()=>Buffer.from('mock wav')},'./auto-run-quick':quick,
   './auto-run-rules':{isPerformanceMode:()=>true},'./audio-splice':{audioToMonoWav:async data=>data},
   './tts-gpu':{wavTiming:()=>({start:.1,end:3.1,duration:3.3,speech:3})},'./qwen-asr':{qwenAsr:async()=>({text:'完整台词'})},
   './llm-metrics':{withLlmMetrics:(_r,_s,fn)=>fn(),llmMetricsForRun:()=>({tokens:null,speed:null})},
   './auto-run-llm':{parseJsonObject:JSON.parse,rewriteChat:async messages=>{judges++;assert.equal(messages[0].promptKey,'quick-pick.system');return{thinking:'选2',content:JSON.stringify({reviews:['1','2'].map(ttsId=>({ttsId,pass:true,missing:[],extra:[],repeated:[],unrelated:[],pronunciationNotes:[],reason:'完整'})),ranking:['2','1'],reason:'断句自然'})};}}
  });
  await api.executeAutoRun('99','TEST',{forceGenerate:false});
  assert.equal(clones,1);assert.equal(judges,1);
  assert.ok(events.some(args=>args[1]==='quick-pick'));assert.deepEqual(updates.at(-1),['passed',null,'2','99']);
 }finally{global.fetch=originalFetch;}
});
