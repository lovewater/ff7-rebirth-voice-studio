/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
function setup({answer={parts:['第一段','第二段','第三段','第四段']},recognized=['甲','乙','丙','丁'],groupAnswer={consistent:true,groups:[[1],[2,3],[4],[5,6]],matches:[true,true,true,true],reason:'逐组一致'}}={}){
 const cache=new Map(),calls=[];let at=0;
 function load(file){if(file.endsWith('.json.ts'))return require(file.slice(0,-3));if(cache.has(file))return cache.get(file).exports;
  const m=new Module(file);cache.set(file,m);m.require=id=>{
   if(id==='./db')return {sql:async()=>[]};
   if(id==='./asr-word-corrections-db')return {loadAsrWordRules:async()=>[]};
   if(id==='./qwen-asr')return {qwenAsr:async()=>({text:recognized[at++],raw:{index:at}})};
   if(id==='./auto-run-llm')return {parseJsonObject:JSON.parse,rewriteChat:async(...args)=>{calls.push(args);return {content:JSON.stringify(args[2].endsWith('-repair')?answer:groupAnswer)}}};
   if(id==='./seed-asr')return {seedAsr:()=>{throw Error('禁止调用远端Seed')}};
   return id.startsWith('./')?load(path.resolve(path.dirname(file),id+'.ts')):require(id);
  };m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);return m.exports;
 }
 return Object.assign({calls},...['auto-run-part-alignment','two-part-regroup','two-part-script','auto-run-two-parts','wav-stretch','speech-part-timeline','gap-only-align','gap-rescue','reference-word-evidence'].map(n=>load(__dirname+'/'+n+'.ts')));
}
function wav(c,durations=[1,1,1,1],gaps=[.6,.7,.8],sr=24000){const pieces=[new Float32Array(Math.round(.12*sr))];durations.forEach((seconds,n)=>{const a=new Float32Array(Math.round(seconds*sr));for(let i=0;i<a.length;i++)a[i]=.4*Math.cos(i*.08);pieces.push(a);if(n<gaps.length)pieces.push(new Float32Array(Math.round(gaps[n]*sr)));});pieces.push(new Float32Array(Math.round(.18*sr)));const out=new Float32Array(pieces.reduce((n,a)=>n+a.length,0));let at=0;for(const a of pieces){out.set(a,at);at+=a.length;}return c.encodeWavMono(sr,out);}
const emptyPlan={enabled:false,onomatopoeia:[],ambient:[],speech:[],subtitleRestore:{preserved:[]}};
test('四段采用420ms日文、250ms中文门槛，逐段缩放与三个留白后精确等长',()=>{
 const c=setup(),ref=wav(c),result=c.alignParts(wav(c,[.9,1.1,.95,1.05],[.25,.25,.25]),ref);
 assert.equal(c.speechChunks(ref,.42).chunks.length,4);assert.equal(c.speechChunks(wav(c,undefined,[.41,.7,.8]),.42).chunks.length,3);
 assert.equal(result.meta.version,'four-parts-v1');assert.equal(result.meta.requiredParts,4);assert.equal(result.meta.status,'correct');assert.equal(result.meta.parts.length,4);
 assert.ok(result.meta.parts.every(p=>p.factor>=.85&&p.factor<=1.15));assert.ok(result.meta.gapsSeconds.every(s=>s>=.25));assert.equal(result.meta.gapsSeconds.length,3);
 assert.equal(c.decodeWavMono(result.audio).samples.length,c.decodeWavMono(ref).samples.length);
 assert.equal(c.alignZeroShotParts(wav(c),ref).meta.requiredParts,4);
});
test('第三、第四段均独立验收，不能用总长或前两段合格掩盖错误',()=>{
 const c=setup(),ref=wav(c);
 for(const index of [2,3]){const durations=[1,1,1,1];durations[index]=.4;const r=c.alignParts(wav(c,durations),ref);assert.equal(r.meta.parts[index].status,'error');assert.equal(r.meta.pass,false);}
 const r=c.alignParts(wav(c,[1,1,1,.7]),ref);assert.equal(r.meta.status,'warning');assert.equal(r.meta.parts[3].status,'warning');
 assert.equal(c.alignParts(wav(c,[1,1,1],[.6,.7]),ref).meta.pass,false);
});
test('四段各中段分别居中，首尾锚点准确，跨采样率只搬留白且所有正文PCM不变',()=>{
 const c=setup(),reference=c.decodeWavMono(wav(c)),edited=c.decodeWavMono(wav(c,[.9,.8,1.2,1.1],[.3,.3,.3],44100));
 const before=edited.samples.slice(),p=c.gapOnlyAlignmentPlan(reference,edited),out=c.alignSpeechGaps(reference,edited);
 assert.equal(p.partCount,4);assert.equal(p.gaps.length,3);assert.ok(p.gaps.every(n=>n>=.25*edited.sampleRate));
 for(const i of [1,2])assert.ok(Math.abs((p.starts[i]+(p.parts[i].end-p.parts[i].start)/2)/edited.sampleRate-(p.referenceParts[i].start+p.referenceParts[i].end)/2/reference.sampleRate)<=2/edited.sampleRate);
 assert.equal(out.length,Math.round(reference.samples.length*edited.sampleRate/reference.sampleRate));
 assert.equal(p.starts[0],Math.round(p.referenceParts[0].start*edited.sampleRate/reference.sampleRate));
 assert.equal(p.starts[3]+p.parts[3].end-p.parts[3].start,out.length-p.trailing);
 p.parts.forEach((part,i)=>assert.deepEqual(out.subarray(p.starts[i],p.starts[i]+part.end-part.start),edited.samples.subarray(part.start,part.end)));
 assert.deepEqual(edited.samples,before);
 const final=c.assembleParts(wav(c),c.encodeWavMono(edited.sampleRate,out),emptyPlan,[],0,wav(c));
 assert.equal(final.fit.version,'four-parts-exact-assembly-v1');assert.equal(final.fit.scales.body,1);assert.equal(final.fit.gaps_s.length,3);
 assert.equal(c.decodeWavMono(final.audio).samples.length,out.length);
});
test('四段中段位置受250ms限制时夹到可行位置，留白不足则拒绝且不截正文',()=>{
 const c=setup(),ref={sampleRate:1000,samples:new Float32Array(8000)},chunks=[{start:100,end:1100},{start:2100,end:3100},{start:4100,end:5100},{start:6100,end:7100}];
 const out=c.layoutPartTimeline(ref,chunks,1000,[new Float32Array(2300),new Float32Array(1000),new Float32Array(1000),new Float32Array(1000)]);
 assert.equal(out.gapsSeconds[0],.25);assert.ok(out.gapsSeconds.every(s=>s>=.25));assert.equal(out.samples.length,8000);
 assert.equal(c.layoutPartTimeline(ref,chunks,1000,Array.from({length:4},()=>new Float32Array(1700))),null);
 const original=wav(c,[2,2,2,2]),failed=c.alignParts(original,wav(c));assert.equal(failed.audio,original);assert.equal(failed.meta.pass,false);
 const three=c.decodeWavMono(wav(c,[1,1,1],[.6,.7]));assert.equal(c.gapOnlyAlignmentPlan(three,c.decodeWavMono(wav(c))),null);
});
test('首次TTS前整理四段，任务独立命名，三段答复及未授权改字均拒绝',async()=>{
 const c=setup(),input={stem:'FOUR',script:'第一段第二段第三段第四段',textJp:'原意',textEn:'',referenceAudio:wav(c),round:1,history:[],allowRewrite:true};
 assert.equal(await c.repairTwoParts(input),'第一段，第二段，第三段，第四段');assert.equal(c.calls[0][2],'four-parts-repair');
 const wrong=setup({answer:{parts:['只有','三','段']}});await assert.rejects(()=>wrong.repairTwoParts(input));
 const changed=setup({answer:{parts:['新字','第二段','第三段','第四段']}});await assert.rejects(()=>changed.repairTwoParts({...input,allowRewrite:false}),/不得改动正文/);
 assert.equal(c.bodyScriptPolicy(input.script,4,4),'strict');
});
test('多于四片连续归四组，片段完整、无重复且顺序不变；逐组核字包含第四组',async()=>{
 const c=setup({recognized:['甲','乙','丙','丁','戊','己']}),groups=[[1],[2,3],[4],[5,6]],audio=wav(c,[1,1,1,1,1,1],[.6,.6,.6,.6,.6]);
 assert.deepEqual(c.validateGroups(groups,6,4),groups);assert.throws(()=>c.validateGroups([[1],[2,3],[4],[4,5,6]],6,4));assert.throws(()=>c.validateGroups([[1],[2,3],[5],[4,6]],6,4));
 const result=await c.regroupTwoPartAudio(audio,'甲，乙丙，丁，戊己','FOUR',4);
 assert.equal(result.meta.version,'four-parts-regroup-v1');assert.equal(result.meta.consistent,true);assert.equal(c.speechChunks(result.audio).chunks.length,4);
 assert.ok(c.calls.every(call=>call[2].startsWith('four-parts-')));
 const bad=setup({recognized:['甲','乙','丙','戊'],groupAnswer:{consistent:false,matches:[true,true,true,false],reason:'第四段误字'}});
 const failure=await bad.regroupTwoPartAudio(wav(bad),'甲，乙，丙，丁','FOUR',4);assert.equal(failure.meta.consistent,false);assert.equal(failure.meta.boundaryMatches[3],false);
});
test('四段最后评选考虑第四段差异，最终检查及元数据识别完整，并发三/四段上下文隔离',async()=>{
 const c=setup();await Promise.all([3,4].map(count=>c.withTwoPartContext(async()=>{
  const ref=wav(c,Array(count).fill(1),Array(count-1).fill(.6));c.setReference(ref,{words:[]},'日文',emptyPlan);await new Promise(r=>setImmediate(r));
  c.rememberRhythm('best',ref,'相同稿');const changed=Array(count).fill(1);changed[count-1]=.6;c.rememberRhythm('bad',wav(c,changed,Array(count-1).fill(.6)),'偏短稿');
  const ranked=c.rankByRhythm([{clip:{id:'bad'}},{clip:{id:'best'}}]);assert.equal(ranked.metrics.reference.requiredParts,count);assert.deepEqual(ranked.items,[{clip:{id:'best'}}]);
  assert.equal(c.inspectFinal(ref,count).pass,true);assert.equal(c.inspectFinal(ref,count===4?3:4).pass,false);
  assert.equal(c.alignmentCheck({conversion_meta:{auto_run_gap_alignment:{version:count===4?'four-parts-v1':'three-parts-v1',pass:true}}}).pass,true);
  const messages=c.performanceRewriteMessages([],'four-parts-repair');assert.ok(messages.some(m=>m.promptKey==='two-parts.rhythm-context'));
 })));
});
test('四段JP每一块都需原始字轴证据，缺第四段不能只凭波形强行分段',()=>{
 const c=setup(),{wave,chunks}=c.speechChunks(wav(c),.42),kept=[{sourceStart:0,sourceEnd:wave.samples.length,targetStart:0}];
 const words=chunks.map((p,i)=>({text:['甲','乙','丙','丁'][i],start:p.start/wave.sampleRate*1000,end:p.end/wave.sampleRate*1000}));
 assert.equal(c.referenceWordEvidence({sampleRate:wave.sampleRate,chunks,kept,words}).pass,true);
 assert.equal(c.referenceWordEvidence({sampleRate:wave.sampleRate,chunks,kept,words:words.slice(0,3)}).pass,false);
});
test('末轮四段切刀必须有三个可靠词界短缝；任一无缝均拒绝，原PCM不变',()=>{
 const c=setup(),x=new Float32Array(4600).fill(.5),words=[{text:'甲',start:100,end:1000},{text:'乙',start:1140,end:2100},{text:'丙',start:2240,end:3200},{text:'丁',start:3340,end:4500}];
 for(const start of [1000,2100,3200])x.fill(0,start,start+140);
 const before=x.slice(),asr={status:'20000000',text:'甲乙丙丁',words,raw:{},utterances:[]};
 const r=c.findGapRescueCuts(x,1000,['甲','乙','丙','丁'],asr,[],'常规分句失败');assert.equal(r.accepted,true);assert.equal(r.boundaries.length,3);assert.equal(r.verifiedChunks.length,4);assert.deepEqual(x,before);
 x.fill(.5,3200,3340);assert.equal(c.findGapRescueCuts(x,1000,['甲','乙','丙','丁'],asr,[],'失败').accepted,false);
});
