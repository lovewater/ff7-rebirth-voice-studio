/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
function setup(texts=['我只是休息一下','好了','快点往上走吧'],answer={consistent:true,groups:[[1],[2,3]],reason:'完整对应'}){
 const cache=new Map(),calls=[];let i=0;
 function load(file){if(file.endsWith('.json.ts'))return require(file.slice(0,-3));if(cache.has(file))return cache.get(file).exports;const m=new Module(file);cache.set(file,m);m.require=id=>{
  if(id==='./qwen-asr')return {qwenAsr:async()=>({text:texts[i++]??'',raw:{}})};
  if(id==='./auto-run-llm')return {parseJsonObject:JSON.parse,rewriteChat:async(...args)=>{calls.push(args);return {content:JSON.stringify(typeof answer==='function'?answer(args[2]):answer)}}};
  return id.startsWith('./')?load(path.resolve(path.dirname(file),id+'.ts')):require(id);
 };m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);return m.exports;}
 return {...load(__dirname+'/two-part-regroup.ts'),...load(__dirname+'/two-part-script.ts'),...load(__dirname+'/gap-only-align.ts'),...load(__dirname+'/wav-stretch.ts'),calls};
}
function audio(c,gaps){const sr=24000,pieces=[new Float32Array(2400)];for(let j=0;j<3;j++){const x=new Float32Array(sr);for(let i=0;i<x.length;i++)x[i]=.4*Math.cos(i*.07);pieces.push(x);if(j<2)pieces.push(new Float32Array(Math.round(gaps[j]*sr)));}pieces.push(new Float32Array(2400));const out=new Float32Array(pieces.reduce((n,x)=>n+x.length,0));let o=0;for(const p of pieces){out.set(p,o);o+=p.length;}return c.encodeWavMono(sr,out);}
test('日文500ms入口与中文250ms分隔独立，短于500ms不进入，多处长停顿不误入',()=>{const c=setup(),a=audio(c,[.6,.3]);assert.equal(c.speechChunks(a).chunks.length,3);assert.equal(c.speechChunks(a,.5).chunks.length,2);assert.ok(c.singleInternalGap(c.decodeWavMono(a),.5));assert.equal(c.speechChunks(audio(c,[.49,.3]),.5).chunks.length,1);assert.equal(c.singleInternalGap(c.decodeWavMono(audio(c,[.6,.6])),.5),null);});
test('合法连续分组全部保留发声，组内240ms、组间>=250ms，实际合为两段',()=>{const c=setup(),a=audio(c,[1.2,.6]),out=c.mergeGroups(a,[[1],[2,3]]);assert.equal(c.speechChunks(out).chunks.length,2);const before=c.decodeWavMono(a),after=c.decodeWavMono(out);assert.equal(after.samples.length,before.samples.length-Math.round(.36*24000));});
test('丢段、重复、倒序、空组和非整数分组一律拒绝',()=>{const c=setup();for(const g of [[[1],[3]],[[1,2],[2,3]],[[2],[1,3]],[[],[1,2,3]],[[1],['2',3]],[[1],[2],[3]]])assert.throws(()=>c.validateGroups(g,3));assert.deepEqual(c.validateGroups([[1,2],[3]],3),[[1,2],[3]]);});
test('逐段识别核字一致后按建议合并，调用携带stem和专用任务日志',async()=>{const c=setup(),a=audio(c,[1.2,.6]),r=await c.regroupTwoPartAudio(a,'我只是休息一下，好了快点往上走吧！','TEST');assert.equal(r.meta.consistent,true);assert.equal(r.meta.segments.length,3);assert.equal(c.speechChunks(r.audio).chunks.length,2);assert.equal(c.calls.at(-1)[2],'two-parts-regroup');assert.equal(c.calls[0][4].stem,'TEST');});
test('核字不一致和无效分组保留原音频，不合并掩盖问题',async()=>{for(const answer of [{consistent:false,groups:[],reason:'缺字'},{consistent:true,groups:[[1],[3]],reason:'错误建议'}]){const c=setup(undefined,answer),a=audio(c,[1.2,.6]),r=await c.regroupTwoPartAudio(a,'测试，正文','TEST');assert.equal(r.meta.consistent,false);assert.equal(r.audio,a);}});
test('空识别不猜测；恰好两段仍核对逐片文字，完全匹配不调模型',async()=>{const c=setup(['正文','','后半']),a=audio(c,[1.2,.6]);assert.equal((await c.regroupTwoPartAudio(a,'正文，后半','TEST')).meta.consistent,false);assert.equal(c.calls.length,0);const two=c.mergeGroups(a,[[1],[2,3]]),ok=setup(['正文','后半']);const r=await ok.regroupTwoPartAudio(two,'正文，后半','TEST');assert.equal(r.meta.consistent,true);assert.equal(r.audio,two);assert.equal(ok.calls.length,0);});
test('唯一句中停顿，末尾语气标点和引号不算额外停顿',()=>{const c=setup();for(const s of ['先休息一下，好了快往上走吧！','先休息一下\n好了快往上走吧！','“先休息一下”，好了快往上走吧！'])assert.ok(c.hasSingleBodyPause(s));for(const s of ['先休息一下','先休息一下，好了，快往上走吧！'])assert.equal(c.hasSingleBodyPause(s),false);});

test('模型只决定两部分边界，程序清理内部多余标点后唯一逗号连接',()=>{const c=setup();assert.equal(c.scriptFromModelParts(['多看、多听、多感受。','那里，会有很多书上学不到的东西！']),'多看多听多感受，那里会有很多书上学不到的东西');assert.equal(c.scriptFromModelParts(['我只是稍微休息一下～','好了快往上走吧！']),'我只是稍微休息一下，好了快往上走吧');assert.equal(c.scriptFromModelParts(['正文','，']),null);});

test('全文一致但把好了并错组，逐组复核拒绝，保留原音频重TTS',async()=>{const c=setup(undefined,task=>task==='two-parts-regroup-groups-check'?{consistent:false,matches:[false,false],reason:'前组多了好了，后组缺少好了'}:{consistent:true,groups:[[1,2],[3]],reason:'全文一致'});const a=audio(c,[1.2,.6]),r=await c.regroupTwoPartAudio(a,'我只是休息一下，好了快点往上走吧！','TEST');assert.equal(r.meta.consistent,false);assert.equal(r.audio,a);assert.equal(c.calls.at(-1)[2],'two-parts-regroup-groups-check');});

test('短句前三批严格第4批放开，14字边界走分行，三段仍严格',()=>{
 const c=setup(),short='一二三四五六七八九十一二三';
 assert.equal(c.bodyScriptPolicy(short,3),'strict');assert.equal(c.bodyScriptPolicy(short,4),'relaxed');
 assert.equal(c.bodyScriptPolicy(short+'四',1),'lines');assert.equal(c.bodyScriptPolicy(short+'四，。',10),'lines');
 assert.equal(c.bodyScriptPolicy(short+'四',4,3),'strict');
});
test('分行目标保留片内标点，不能把标点数当目标片数',()=>{
 const c=setup(),script='行吧，总能有办法的。\n只要我出马，飞到哪都不是问题。';
 assert.equal(c.validBodyScript(script,2,'lines'),true);assert.equal(c.hasBodyParts(script,2),false);
 assert.equal(c.validBodyScript(script.replace('\n',''),2,'lines'),false);
 assert.equal(c.scriptFromPolicyParts(['行吧，总能有办法的。','只要我出马，飞到哪都不是问题。'],2,'lines'),script);
 assert.equal(c.validBodyScript('行吧，总能有办法的。只要我出马，飞到哪都不是问题。',2,'relaxed'),true);
});
test('长句Qwen全文核字后按行而非行内标点归组，保留正确目标边界',async()=>{
 const c=setup(['行吧总能有办法的','只要我出马','飞到哪都不是问题']),a=audio(c,[.6,.6]);
 const r=await c.regroupTwoPartAudio(a,'行吧，总能有办法的。\n只要我出马，飞到哪都不是问题。','TEST',2,'lines');
 assert.equal(r.meta.consistent,true);assert.equal(c.speechChunks(r.audio).chunks.length,2);
 const input=JSON.parse(c.calls[1][0][1].promptValues.input_json);
 assert.deepEqual(input.expectedParts,['行吧，总能有办法的。','只要我出马，飞到哪都不是问题。']);assert.equal(input.scriptPolicy,'lines');
});
test('短句放开后全文核字通过可模型归组，缺字仍失败',async()=>{
 const c=setup(),a=audio(c,[.6,.6]),r=await c.regroupTwoPartAudio(a,'我只是休息一下，好了，快点往上走吧！','TEST',2,'relaxed');
 assert.equal(r.meta.consistent,true);assert.equal(c.speechChunks(r.audio).chunks.length,2);
 const bad=setup(undefined,{consistent:false,reason:'漏字'}),b=audio(bad,[.6,.6]);
 assert.equal((await bad.regroupTwoPartAudio(b,'正文','TEST',2,'relaxed')).meta.consistent,false);
});

test('按行归组全文正确但跨行搬词仍拒绝',async()=>{
 const c=setup(['行吧','总能有办法的只要我出马','飞到哪都不是问题'],task=>task==='two-parts-regroup-groups-check'?{consistent:false,matches:[false,false],reason:'把第一行词移到了第二行'}:{consistent:true,groups:[[1],[2,3]],reason:'全文一致'}),a=audio(c,[.6,.6]);
 const r=await c.regroupTwoPartAudio(a,'行吧，总能有办法的。\n只要我出马，飞到哪都不是问题。','TEST',2,'lines');assert.equal(r.meta.consistent,false);assert.equal(r.audio,a);
});

test('短句放开后parts数量也不限，保留自然多个停顿',()=>{const c=setup();assert.equal(c.scriptFromPolicyParts(['先等等，','好了，','走吧！'],2,'relaxed'),'先等等，\n好了，\n走吧！');});

test('片数正确但把其实单独切开：全文完整也须拒绝错误切口，不假称第一段太短',async()=>{
 const c=setup(['其实','是因为猫不见了我很担心'],{consistent:false,matches:[false,false],reason:'第一段仅其实，后半段混入了第一行正文'});
 const a=c.mergeGroups(audio(c,[.8,.8]),[[1],[2,3]]);
 const r=await c.regroupTwoPartAudio(a,'其实是因为猫不见了\n我很担心','TEST',2,'lines');
 assert.equal(r.meta.consistent,false);assert.equal(r.meta.textConsistent,true);assert.equal(r.audio,a);assert.equal(c.calls.at(-1)[2],'two-parts-boundary-check');
});
test('三段片数刚好也逐段核对，近音通过后仍保留原音频与分界',async()=>{
 const c=setup(['第一句','第二句','第三句'],{consistent:true,matches:[true,true,true],reason:'近音允许'}),a=audio(c,[.6,.6]);
 const r=await c.regroupTwoPartAudio(a,'第一句\n第二句\n第三句','TEST',3,'lines');assert.equal(r.meta.consistent,true);assert.equal(r.audio,a);assert.equal(c.calls.length,0);
});

test('前三批失败后为第4批放开正文改写，两段三段共用，不按3个候选计数',()=>{
 const c=setup();
 for(const required of [2,3]){
  for(const batch of [1,2])assert.equal(c.allowBodyRewrite(batch,[1,1,1],required),false);
  for(const batch of [3,4,9])assert.equal(c.allowBodyRewrite(batch,[1,1,1],required),true);
  assert.equal(c.allowBodyRewrite(1,[1,required,1],required),true);
  assert.equal(c.allowBodyRewrite(3,[],required),false);
 }
});
