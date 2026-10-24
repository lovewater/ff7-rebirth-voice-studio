/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
function setup(repairAnswer){const cache=new Map(),calls=[];let word=0;
 function load(file){if(file.endsWith('.json.ts'))return require(file.slice(0,-3));if(cache.has(file))return cache.get(file).exports;const m=new Module(file);cache.set(file,m);m.require=id=>{
  if(id==='./qwen-asr')return{qwenAsr:async()=>({text:['甲','乙','丙','丁'][word++],raw:{}})};
  if(id==='./auto-run-llm')return{parseJsonObject:JSON.parse,rewriteChat:async(...args)=>{calls.push(args);return{content:JSON.stringify(args[2].includes('repair')?(repairAnswer??{parts:['第一段','第二段','第三段']}):{consistent:true,groups:[[1],[2,3],[4]],reason:'完整对应'})}}};
  return id.startsWith('./')?load(path.resolve(path.dirname(file),id+'.ts')):require(id);
 };m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);return m.exports;}
 return {...load(__dirname+'/auto-run-part-alignment.ts'),...load(__dirname+'/two-part-regroup.ts'),...load(__dirname+'/two-part-script.ts'),...load(__dirname+'/auto-run-two-parts.ts'),...load(__dirname+'/wav-stretch.ts'),calls};}
function wav(c,durations=[1,1,1],gaps=[.6,.7],sr=24000){const pieces=[new Float32Array(Math.round(.12*sr))];durations.forEach((s,n)=>{const a=new Float32Array(Math.round(s*sr));for(let i=0;i<a.length;i++)a[i]=.4*Math.cos(i*.08);pieces.push(a);if(n<gaps.length)pieces.push(new Float32Array(Math.round(gaps[n]*sr)));});pieces.push(new Float32Array(Math.round(.18*sr)));const out=new Float32Array(pieces.reduce((n,a)=>n+a.length,0));let at=0;for(const a of pieces){out.set(a,at);at+=a.length;}return c.encodeWavMono(sr,out);}
test('三段沿用450ms日文入口与250ms中文切分，不能把较短停顿算成第三段',()=>{const c=setup();assert.equal(c.speechChunks(wav(c),.45).chunks.length,3);assert.equal(c.speechChunks(wav(c,undefined,[.44,.7]),.45).chunks.length,2);assert.equal(c.alignParts(wav(c),wav(c,undefined,[.44,.7])).meta.requiredParts,2);});
test('三段各自85%～115%缩放，两处间隔均>=250ms且最终采样等长',()=>{const c=setup(),ref=wav(c),r=c.alignParts(wav(c,[.9,1.1,1]),ref);assert.equal(r.meta.version,'three-parts-v1');assert.equal(r.meta.status,'correct');assert.equal(r.meta.parts.length,3);assert.ok(r.meta.gapsSeconds.every(s=>s>=.25));assert.equal(c.decodeWavMono(r.audio).samples.length,c.decodeWavMono(ref).samples.length);});
test('三段总长一样也不能掩盖中段>300ms错误，轻微残差为警告',()=>{const c=setup(),ref=wav(c);assert.equal(c.alignParts(wav(c,[1,.4,1]),ref).meta.status,'error');assert.equal(c.alignParts(wav(c,[1,.7,1]),ref).meta.status,'warning');});
test('三段放不下两处最小间隔时保留原声音，禁止截正文凑长',()=>{const c=setup(),a=wav(c,[2,2,2]),r=c.alignParts(a,wav(c));assert.equal(r.meta.status,'error');assert.equal(r.audio,a);});
test('三段最终组装不同采样率也等长，不再整体变速',()=>{const c=setup(),jp=wav(c),r=c.alignParts(wav(c,[.9,1.1,1],[.3,.3],44100),jp),out=c.assembleParts(jp,r.audio,{enabled:false},[],0,jp);assert.equal(c.decodeWavMono(out.audio).samples.length,Math.round(c.decodeWavMono(jp).samples.length*44100/24000));assert.equal(out.fit.scales.body,1);assert.equal(out.fit.gaps_s.length,2);});
test('三段文字恰好两个分隔符，不足三段必须重整；模型分界程序清理',()=>{const c=setup();assert.equal(c.hasBodyParts('前面，中间，后面！',3),true);assert.equal(c.hasBodyParts('前面，后面！',3),false);assert.equal(c.scriptFromModelParts(['前、面','中，间','后面！'],3),'前面，中间，后面');assert.equal(c.scriptFromModelParts(['只有','两段'],3),null);});
test('第一条TTS前专门模型整理三段，返回不足三段不能通过',async()=>{const c=setup(),r=await c.repairTwoParts({stem:'TEST',script:'第一段第二段第三段',textJp:'原意',textEn:'',referenceAudio:wav(c),round:1,history:[],allowRewrite:true});assert.equal(r,'第一段，第二段，第三段');assert.equal(c.calls[0][2],'three-parts-repair');});
test('四个小片段核字后可连续并成三段，每个原片段只用一次',async()=>{const c=setup(),a=wav(c,[1,1,1,1],[.6,.6,.6]);assert.deepEqual(c.validateGroups([[1],[2,3],[4]],4,3),[[1],[2,3],[4]]);assert.throws(()=>c.validateGroups([[1],[2,3],[3,4]],4,3));const r=await c.regroupTwoPartAudio(a,'甲，乙丙，丁','TEST',3);assert.equal(r.meta.consistent,true);assert.equal(c.speechChunks(r.audio).chunks.length,3);});

test('三段各自仅警告但放不下两处250ms间隔，必须升级错误',()=>{const c=setup(),r=c.alignParts(wav(c,[1.4,1.4,1.4],[.3,.3]),wav(c,[1,1,1],[.5,.5]));assert.ok(r.meta.parts.every(p=>p.status==='warning'));assert.equal(r.meta.status,'error');assert.equal(r.meta.pass,false);});

test('长句专门整理保留每行内部标点，不因多个小停顿拒绝',async()=>{
 const parts=['行吧，总能有办法的。','只要我出马，飞到哪都不是问题。'],c=setup({parts});
 await c.withTwoPartContext(async()=>{c.setBodyScriptPolicy('lines');const r=await c.repairTwoParts({stem:'TEST',script:parts.join(''),textJp:'原意',textEn:'',referenceAudio:wav(c,[1,1],[.6]),round:1,history:[]});assert.equal(r,parts.join('\n'));assert.equal(c.calls[0][0][1].promptValues.input_json.includes('"scriptPolicy":"lines"'),true);});
});
test('短句放开后可直接返回自然多停顿；长句仍拒绝单行与改字',async()=>{
 const c=setup({spoken_text:'先等等，好了，走吧！'});
 await c.withTwoPartContext(async()=>{c.setBodyScriptPolicy('relaxed');assert.equal(await c.repairTwoParts({stem:'TEST',script:'先等等好了走吧',textJp:'原意',textEn:'',referenceAudio:wav(c,[1,1],[.6]),round:1,history:[]}), '先等等，好了，走吧！');c.setBodyScriptPolicy('lines');await assert.rejects(()=>c.repairTwoParts({stem:'TEST',script:'先等等好了走吧',textJp:'原意',textEn:'',referenceAudio:wav(c,[1,1],[.6]),round:1,history:[]}));});
});

test('单段正文只有环境音时走整句编辑，不误入情绪严格装配导致反复改稿',()=>{
 const c=setup(),jp=wav(c,[1],[]),cn=wav(c,[.9],[]),plan={enabled:true,onomatopoeia:[],ambient:[{startMs:0,endMs:100}],speech:[{startMs:100,endMs:1300}]};
 const result=c.assemblePreserved(jp,cn,plan,[{src:'env',index:0},{src:'tts',startMs:0,endMs:null}],1.3,cn);
 assert.ok(result.audio.length>44);assert.notEqual(result.fit.version,'emotion-exact-silence-assembly-v1');
});
