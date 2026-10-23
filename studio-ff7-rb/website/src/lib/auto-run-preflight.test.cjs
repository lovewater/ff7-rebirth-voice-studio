/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function compile(file,overrides){const m=new Module(__filename);m.require=id=>overrides[id]??(id==='./auto-run-model-policy'?{runAutoRunModels:input=>input.attempt(),captureAutoRunOutcome:()=>false}:id==='./shushu-emotion'?require('./shushu-emotion.ts'):id==='./singing-original'?{isSingingLine:()=>false}:id.startsWith('./')?{}:require(id));m._compile((overrides['test-fetch']?'const fetch=require("test-fetch");\n':'')+ts.transpileModule(fs.readFileSync(`${__dirname}/${file}`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText+(file==='auto-run.ts'?'\nexports.__setWorkflows=(performance,casual)=>{runPerformance=performance;runCasual=casual;};exports.__setOriginal=fn=>{runOriginalJapanese=fn;};':''),`${__dirname}/${file}`);return m.exports;}
const quickModule=()=>compile('auto-run-quick.ts',{'./timing':compile('timing.ts',{}),'./spoken-text-review':compile('spoken-text-review.ts',{}),'./auto-run-script-policy':require('./auto-run-script-policy.ts'),'./beats':require('./beats.ts')});
const normal={id:'7',audio_path:'tts/example.wav',spoken_text:'完整的中文台词',tts_text:'完整的中文台词',review_state:"candidate",passed:false,start_s:.1,end_s:3.1,dur_s:3.3,speech_s:3,jp_start_s:.1,jp_end_s:3.1,jp_dur_s:3.3,jp_speech_s:3};
function startHarness(rows,extra={}){
 const queries=[];
 const sql=async parts=>{const q=parts.join('?');queries.push(q);
  if(q.includes('SELECT l.stem'))return[{stem:'TEST',dialogue_mode:'scene',text_jp:'これは通常速度の台詞です'}];
  if(q.includes('selected_tts_id::text AS selected_tts_id'))return extra.previous?[extra.previous]:[];
  if(q.includes("status = 'running'"))return extra.running?[extra.running]:[];
  if(q.includes('SELECT v.id::text'))return rows;
  if(q.includes('INSERT INTO line_auto_runs'))return[{id:'99'}];
  if(q.includes('INSERT INTO line_auto_run_events')||q.includes('SET updated_at'))return[];
  throw Error('unexpected query '+q);
 };
 sql.json=x=>x;
 const api=compile('auto-run.ts',{'./db':{sql},'node:fs/promises':{stat:async()=>{if(extra.missing)throw Error('ENOENT');return{size:100};},readFile:async()=>Buffer.alloc(44)},'./auto-run-rules':{isPerformanceMode:()=>true},'./auto-run-quick':quickModule(),
  'test-fetch':async()=>{if(extra.beatError)throw Error('service down');return Response.json({results:[{jp:{status:'ok',mora:30},normalizedRatio:extra.ratio??1}]});},
  './audio-splice':{audioToMonoWav:async b=>b},'./tts-gpu':{wavTiming:()=>({start:.1,end:3.1})},'./wav-stretch':{decodeWavMono:()=>({sampleRate:1000,samples:new Float32Array(3000)})},'./speech-segmentation':{measurePerformanceSpeakingTime:()=>({speechSeconds:3})}});
 return{api,queries};
}
test('batch defaults skip existing suitable output without creating a run or changing it',async()=>{
 const {api,queries}=startHarness([normal]);
 assert.deepEqual(await api.startAutoRun('TEST'),{skipped:true,selectedTtsId:'7',reason:'已有时间检查正常的成品'});
 assert.equal(queries.some(q=>q.includes('INSERT')||q.includes('UPDATE')),false);
});
test('human force bypasses suitability and starts full workflow even with a locked result',async()=>{
 const {api,queries}=startHarness([{...normal,review_state:"locked"}]);
 assert.deepEqual(await api.startAutoRun('TEST',{forceGenerate:true}),{skipped:false,id:'99',kind:'performance'});
 assert.equal(queries.some(q=>q.includes('SELECT v.id::text')),false);
});
test('locked or previously passed output is reusable; bad or missing files are not',async()=>{
 for(const row of [{...normal,start_s:null,review_state:"locked"},{...normal,start_s:null,passed:true,complete_passed:true}])assert.equal((await startHarness([row]).api.startAutoRun('TEST',{forceGenerate:false})).skipped,true);
 assert.equal((await startHarness([{...normal,speech_s:.7}]).api.startAutoRun('TEST')).skipped,false);
 assert.equal((await startHarness([normal],{missing:true}).api.startAutoRun('TEST')).skipped,false);
});
test('an old quick-passed flag or timing-only result cannot bypass the new beat gate',async()=>{
 for(const passed of [false,true]){
  const h=startHarness([{...normal,passed}],{ratio:1.458});assert.equal((await h.api.startAutoRun('TEST')).skipped,false);
  assert.ok(h.queries.some(q=>q.includes('INSERT INTO line_auto_run_events')));
 }
 assert.equal((await startHarness([normal],{beatError:true}).api.startAutoRun('TEST')).skipped,false);
});
test('locks, verified full-workflow exemptions and separate manual-review fallback are preserved',async()=>{
 for(const row of [{...normal,review_state:"locked"},{...normal,passed:true,complete_passed:true},{...normal,passed:true,voice_gpu_key:'jp-lock'},{...normal,workflow:'whole-line-fallback'}])assert.equal((await startHarness([row],{ratio:1.458}).api.startAutoRun('TEST')).skipped,true);
});
test('force does not override running-job conflict protection',async()=>{
 const {api}=startHarness([normal],{running:{id:'8',updated_at:new Date().toISOString()}});
 await assert.rejects(api.startAutoRun('TEST',{forceGenerate:true}),e=>e.status===409);
});
test('batch skips every recorded workflow by stem, even failed, incomplete or currently running, without writes or quality checks',async()=>{
 for(const status of ['passed','failed','running'])for(const selected_tts_id of ['8',null]){
  const h=startHarness([],{previous:{id:'3',status,selected_tts_id},missing:true,beatError:true});
  const result=await h.api.startAutoRun('TEST',{forceGenerate:false});
  assert.equal(result.skipped,true);assert.equal(result.selectedTtsId,selected_tts_id);
  assert.equal(h.queries.some(q=>q.includes('INSERT')||q.includes('UPDATE')||q.includes('SELECT v.id::text')),false);
 }
});
test('manual force can rerun an earlier failed workflow and bypasses batch history lookup',async()=>{
 const h=startHarness([],{previous:{id:'3',status:'failed',selected_tts_id:'8'}});
 assert.equal((await h.api.startAutoRun('TEST',{forceGenerate:true})).skipped,false);
 assert.equal(h.queries.some(q=>q.includes('selected_tts_id::text AS selected_tts_id')),false);
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

// 真实执行入口回归：新句没有历史/修改稿，也不能先生成原稿并提前通过。
for(const forceGenerate of [false,true])for(const performance of [false,true])test(`自动运行直接进入完整${performance?'表演':'普通对话'}流程 force=${forceGenerate}`,async()=>{
 const events=[],workflows=[],line={stem:'TEST',text_zh:'原字幕',dialogue_mode:performance?'scene':'field'};
 const sql=async(parts,...args)=>{const q=parts.join('?');
  if(q.includes('SELECT l.stem'))return[line];
  if(q.includes('INSERT INTO line_auto_run_events'))events.push({step:args[1],message:args[3]});
  if(q.includes('SELECT count(*)'))throw Error('不得进入原稿快速生成');
  return[];
 };sql.json=x=>x;
 const api=compile('auto-run.ts',{
  './db':{sql},'./auto-run-rules':{isPerformanceMode:()=>performance},
  './llm-metrics':{withLlmMetrics:(_r,_s,fn)=>fn()},
  './auto-run-two-parts':{withTwoPartContext:fn=>fn()},
  'test-fetch':async()=>{throw Error('在完整工作流之前不得TTS或请求择优模型');}
 });
 api.__setWorkflows(async(...args)=>workflows.push(['performance',...args]),async(...args)=>workflows.push(['casual',...args]));
 await api.executeAutoRun('99','TEST',{forceGenerate});
 assert.equal(workflows.length,1);assert.equal(workflows[0][0],performance?'performance':'casual');
 assert.ok(events.some(e=>e.step==='workflow-entry'));
 assert.equal(events.some(e=>['quick-start','quick-pick','quick-timing'].includes(e.step)),false);
});

test('成品复用8字以内无字数门槛，9–11字仍采用原比值范围',()=>{
 const {quickBeatPass}=quickModule();
 const input={textJp:'甲乙丙丁戊己庚辛壬',spoken:'完整中文台词',speechSeconds:2,beats:{jp:{status:'ok',mora:10},jpSpeech:{status:'ok',mora:10},normalizedRatio:.8}};
 assert.equal(quickBeatPass(input).pass,true);
 for(const spoken of ['怎么了','这是一句自然且完整的中文表达无需字数上限'])assert.equal(quickBeatPass({...input,textJp:'甲乙丙丁戊己庚辛',spoken,beats:{...input.beats,normalizedRatio:3}}).pass,true);
 assert.equal(quickBeatPass({...input,beats:{...input.beats,normalizedRatio:1.11}}).pass,false);
 assert.equal(quickBeatPass({...input,textJp:'甲乙丙丁戊己庚辛壬癸子丑'}).pass,false);
});

for(const performance of [false,true])test(`纯咻在ASR/TTS/模型调用前直接分流原声，场景=${performance}`,async()=>{
 const calls=[],line={stem:'TEST',text_jp:'シュシュシュ',text_zh:'咻咻咻！',dialogue_mode:performance?'scene':'field'};
 const sql=async parts=>parts.join('?').includes('SELECT l.stem')?[line]:[];sql.json=x=>x;
 const api=compile('auto-run.ts',{'./db':{sql},'./auto-run-rules':{isPerformanceMode:()=>performance},'node:fs/promises':{readFile:async file=>{calls.push(['read',file]);return Buffer.from('original');}},'./llm-metrics':{withLlmMetrics:(_r,_s,fn)=>fn()},'./auto-run-two-parts':{withTwoPartContext:fn=>fn()}});
 api.__setWorkflows(async()=>{throw Error('不得进入Seed');},async()=>{throw Error('不得进入TTS');});
 api.__setOriginal(async(run,line,audio,route)=>calls.push(['original',audio.toString(),route.workflow]));
 await api.executeAutoRun('99','TEST',{forceGenerate:true});
 assert.equal(calls.length,2);assert.deepEqual(calls[1],['original','original','xiu-only-original']);
});
