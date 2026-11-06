/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),Module=require('node:module');
function compile(file,mocks={}){const m=new Module(__filename);m.require=id=>Object.hasOwn(mocks,id)?mocks[id]:id==='./auto-run-rules'?require('./auto-run-rules.ts'):id.startsWith('@/')?{}:require(id);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/'+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,__filename);return m.exports;}
const policy=compile('auto-run-gap-policy.ts');
async function request(body,persisted={stage:3,model:'grok',allowGapSplit:true},running=true,mode='scene'){
 let prompts=0,queries=0;
 const sql=async parts=>{queries++;return parts.join('').includes('FROM lines l')?[{stem:'TEST',speaker:'cloud',dialogue_mode:mode}]:running?[{id:'7',stage_payload:persisted}]:[];};
 const route=compile('../app/api/lines/[stem]/tts/clone/route.ts',{
  '@/lib/db':{sql},'@/lib/line-processing-state':{isLineSkipped:()=>false},'@/lib/source-audio-policy':{audioReferenceIssue:()=>null},'@/lib/auto-run-gap-policy':policy,'@/lib/auto-run-stage-context':{AUTO_RUN_MODEL:'grok'},
  '@/lib/tts-gpu':{normalizeScript:()=>({ttsText:'原稿',spokenText:'原稿'})},
  '@/lib/prompt-refs':{resolvePromptRef:async()=>{prompts++;return{ok:false};}},
  'next/server':{NextResponse:{json:(body,options)=>({body,status:options?.status??200})}},
 });
 const response=await route.POST({json:async()=>body},{params:Promise.resolve({stem:'TEST'})});return{response,prompts,queries};
}
test('clone route accepts all explicitly matching Grok stages before prompt selection; no synthesis runs',async()=>{
 for(const stage of [1,2,3]){
  const result=await request({autoRunId:'7',autoRunStage:stage,autoRunModel:'grok'},{stage,model:'grok',allowGapSplit:stage===3});
  assert.equal(result.prompts,1);assert.equal(result.response.status,400);assert.match(result.response.body.error,/参考音色/);
 }
});
test('historic GLM cannot be claimed as Grok and implicit or stale HTTP stage/model claims stop before inference',async()=>{
 for(const [body,persisted,running] of [
  [{autoRunId:'7',autoRunStage:3,autoRunModel:'grok'},{stage:3,model:'primary',allowGapSplit:true}],
  [{autoRunId:'7',autoRunStage:3,autoRunModel:'primary'},{stage:3,model:'grok',allowGapSplit:true}],
  [{autoRunId:'7',autoRunStage:3},{stage:3,model:'grok',allowGapSplit:true}],
  [{autoRunId:'7',autoRunModel:'grok'},{stage:3,model:'grok',allowGapSplit:true}],
  [{autoRunId:'7',autoRunStage:3,autoRunModel:'grok'},{stage:2,model:'grok',allowGapSplit:false}],
  [{autoRunId:'7',autoRunStage:3,autoRunModel:'grok'},{stage:3,model:'grok',allowGapSplit:true},false],
 ]){const result=await request(body,persisted,running);assert.equal(result.response.status,409);assert.equal(result.prompts,0);}
});
test('manual clone does not claim a running model stage and invalid model IDs are rejected',async()=>{
 const manual=await request({});assert.equal(manual.prompts,1);assert.equal(manual.queries,1);
 const invalid=await request({autoRunId:'7',autoRunStage:3,autoRunModel:'other'});assert.equal(invalid.response.status,400);assert.equal(invalid.prompts,0);
});

test('HTTP candidate count gate rejects manual/scene/invalid claims before any inference and accepts ordinary1/3',async()=>{
 for(const candidateCount of [1,3]) {
  const manual=await request({candidateCount});assert.equal(manual.response.status,400);assert.equal(manual.prompts,0);
  const scene=await request({autoRunId:'7',autoRunStage:1,autoRunModel:'grok',candidateCount},{stage:1,model:'grok',allowGapSplit:false});assert.equal(scene.response.status,400);assert.equal(scene.prompts,0);
  for(const feedbackRound of [true,false]) {
   const ordinary=await request({autoRunId:'7',autoRunStage:1,autoRunModel:'grok',candidateCount,feedbackRound},{stage:1,model:'grok',allowGapSplit:false},true,'unknown');assert.equal(ordinary.prompts,1);
  }
 }
 for(const candidateCount of [2,0,'3',null]){const r=await request({autoRunId:'7',autoRunStage:1,autoRunModel:'grok',candidateCount},{stage:1,model:'grok',allowGapSplit:false},true,'field');assert.equal(r.prompts,0);assert.equal(r.response.status,400);}
});

test('qualified scene optimization uses the existing implicit three-candidate contract',async()=>{
 const extra={promptPath:'tts/TEST/qualified-prompt.wav',preservePromptAudio:true,bodyScriptPolicy:'lines'};
 const result=await request({ttsText:'优化稿',autoRunId:'7',autoRunStage:1,autoRunModel:'grok',...extra},{stage:1,model:'grok',allowGapSplit:false});
 assert.equal(result.prompts,1);assert.match(result.response.body.error,/参考音色/);
 assert.equal(policy.cloneCandidateCount(undefined,'7',1,'scene',false),3);
});

test('explicit GLM clone stages require matching persisted GLM and reach reference selection',async()=>{
 for(const stage of [1,2,3]){const r=await request({autoRunId:'7',autoRunStage:stage,autoRunModel:'primary'},{stage,model:'primary',allowGapSplit:stage===3});assert.equal(r.prompts,1);assert.match(r.response.body.error,/参考音色/);}
});
