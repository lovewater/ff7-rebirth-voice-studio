/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const cache=new Map();function load(file){if(file.endsWith('.json.ts'))return require(file.slice(0,-3));if(file.endsWith('/db.ts'))return {sql:()=>{throw Error('单测禁止数据库调用')}};if(cache.has(file))return cache.get(file).exports;const m=new Module(file);cache.set(file,m);m.require=id=>id.startsWith('./')?load(path.resolve(path.dirname(file),id+'.ts')):require(id);m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);return m.exports;}
const {alignParts,alignZeroShotParts,assembleParts,PartAssemblyError}=load(__dirname+'/auto-run-part-alignment.ts');
const {encodeWavMono:encode,decodeWavMono:decode}=load(__dirname+'/wav-stretch.ts');
function wav(first,gap,second,sr=24000,lead=.1,tail=.1){const a=new Float32Array(Math.round((lead+first+gap+second+tail)*sr));for(const [x,y]of[[lead,lead+first],[lead+first+gap,lead+first+gap+second]])for(let i=Math.round(x*sr);i<Math.round(y*sr);i++)a[i]=.35*Math.cos(2*Math.PI*180*i/sr);return encode(sr,a);}
const plan={enabled:false,onomatopoeia:[],ambient:[],speech:[]};
test('入口500ms与候选250ms分开；短停顿不误入，手工编辑默认250ms不变',()=>{
 const {singleInternalGap}=load(__dirname+'/gap-only-align.ts');
 assert.equal(alignParts(wav(1,.4,1),wav(1,.49,1)),null);
 assert.ok(alignParts(wav(1,.25,1),wav(1,1,1)));
 assert.ok(alignParts(wav(1,.25,1),wav(1,.5,1)));
 assert.ok(alignParts(wav(1,.25,1),wav(1,.53,1))); // 6400_0600实测530ms应进入
 assert.ok(singleInternalGap(decode(wav(1,.25,1))));
});
test('正确、警告、错误以缩放后的逐段余差区分，总长相等不能掩盖错误',()=>{
 const ref=wav(1,1.2,1);
 assert.equal(alignParts(wav(1,.3,1),ref).meta.status,'correct');
 const warning=alignParts(wav(.65,.3,1),ref);
 assert.equal(warning.meta.status,'warning');assert.equal(warning.meta.pass,true);
 const error=alignParts(wav(.4,.3,1),ref);
 assert.equal(error.meta.status,'error');assert.equal(error.meta.pass,false);
 for(const p of warning.meta.parts)assert.ok(p.factor>=.85&&p.factor<=1.15);
});
test('两段过长放不下250ms间隔时记录错误，不能截声音',()=>{
 const result=alignParts(wav(2,.3,2),wav(1,1,1));
 assert.equal(result.meta.status,'error');assert.equal(result.meta.pass,false);

});
test('最终按完整JP重新分配中间间隔，采样率不同也等长，不整体再拉伸',()=>{
 const jp=wav(1,1.2,1,24000,.12,.18),reference=wav(1,1.2,1,24000,.001,.001);
 const aligned=alignParts(wav(.9,.3,1.1,44100),reference);
 const out=assembleParts(jp,aligned.audio,plan,[],99,reference);
 assert.equal(decode(out.audio).samples.length,Math.round(decode(jp).samples.length*44100/24000));
 assert.equal(out.fit.scales.body,1);assert.equal(out.ok,true);
});
test('最终正文装不下且无法保留250ms间隔时必须抛错误',()=>{
 const jp=wav(1,1,1),cn=wav(1.5,.25,1.5);
 assert.throws(()=>assembleParts(jp,cn,plan,[],2.55,jp),PartAssemblyError);
});
test('情绪原声与单段正文只调中间留白，最终必须等长',()=>{
 const jp=wav(.4,.9,.8),cn=encode(24000,decode(wav(.8,0,0)).samples.subarray(0,24000));
 const emotion={enabled:true,onomatopoeia:[{startMs:0,endMs:500,text:'ううん'}],ambient:[],speech:[{startMs:1400,endMs:2200,text:'ぜんぶ'}]};
 const out=assembleParts(jp,cn,emotion,[{src:'ono',index:0},{src:'tts',startMs:0,endMs:null}],2.3,jp);
 assert.ok(Math.abs(decode(out.audio).samples.length-decode(jp).samples.length)<=1);
 assert.ok(Object.values(out.fit.scales).every(x=>x===1));
});
test('笑声与正文直接相接：正负50ms以内保留拼装，超过50ms才失败',()=>{
 const {assemblyLengthPass}=load(__dirname+'/auto-run-part-alignment.ts');
 const tone=(seconds)=>encode(24000,new Float32Array(Math.round(seconds*24000)).fill(.35));
 const jp=tone(1),emotion={enabled:true,onomatopoeia:[{startMs:0,endMs:500,text:'笑声'}],ambient:[],speech:[{startMs:500,endMs:1000,text:'正文'}]};
 const pieces=[{src:'ono',index:0},{src:'tts',startMs:0,endMs:null}];
 for(const delta of [-.05,-.049,.005,.049,.05]){
  const out=assembleParts(jp,tone(.5+delta),emotion,pieces,1,jp);
  assert.equal(out.ok,true);assert.ok(Math.abs(out.fit.actual_s-1-delta)<1/24000);
  assert.equal(out.fit.tolerance_s,.05);assert.ok(Object.values(out.fit.scales).every(x=>x===1));
  assert.ok(Math.abs(decode(out.audio).samples[0]-decode(jp).samples[0])<=4/32768); // 多次PCM16编码的量化误差。
 }
 for(const delta of [-.051,.051])assert.throws(()=>assembleParts(jp,tone(.5+delta),emotion,pieces,1,jp),PartAssemblyError);
 assert.equal(assemblyLengthPass(1.05,1),true);assert.equal(assemblyLengthPass(.95,1),true);
 assert.equal(assemblyLengthPass(1.051,1),false);assert.equal(assemblyLengthPass(NaN,1),false);
});
test('四并发固定原意与节奏上下文互不串句，每轮重新附带原始日中字幕',async()=>{
 const rhythm=load(__dirname+'/auto-run-two-parts.ts');
 await Promise.all(Array.from({length:4},(_,i)=>rhythm.withTwoPartContext(async()=>{
  rhythm.setMeaningAnchor({japanese:'原日文'+i,chinese:'原中文'+i,earliestDialogue:[{japanese:'前句',chinese:'前文'}]});
  rhythm.setReference(wav(1,1.2,1),{words:[]},'原日文'+i,{subtitleRestore:{preserved:[]}});
  await new Promise(r=>setTimeout(r,4-i));
  for(let round=0;round<3;round++){
   const messages=rhythm.performanceRewriteMessages([{role:'user',content:'最新稿'+round}],'two-parts-repair');
   const anchor=JSON.parse(messages.find(m=>m.promptKey==='two-parts.meaning-anchor').promptValues.input_json);
   assert.equal(anchor.chinese,'原中文'+i);assert.equal(anchor.japanese,'原日文'+i);
   assert.ok(messages.some(m=>m.promptKey==='two-parts.rhythm-context'));
  }
 })));
});

test('手动Zero-shot仅两边均为两段时分段缩放，保留完整日文首尾和总长',()=>{
 const jp=wav(1,1.2,1,24000,.23,.41);
 const out=alignZeroShotParts(wav(.9,.3,1.1),jp);
 assert.ok(out);assert.equal(out.meta.status,'correct');
 assert.equal(decode(out.audio).samples.length,decode(jp).samples.length);
 const {singleInternalGap}=load(__dirname+'/gap-only-align.ts');
 const gap=singleInternalGap(decode(out.audio));assert.ok(Math.abs(gap.start-Math.round(.23*24000))<=.01*24000); // 变速起音与10ms波形帧允许少量偏差

 assert.equal(alignZeroShotParts(wav(1,.1,1),jp),null);
 assert.equal(alignZeroShotParts(wav(1,.3,1),wav(1,.1,1)),null);
 const bad=alignZeroShotParts(wav(.4,.3,1),jp);
 assert.equal(bad.meta.status,'error');assert.equal(bad.meta.pass,false);
});

test('普通对话最终三段缩放保持完整总长，中段对齐日文中段中心，片数不符不套用',()=>{
 const {speechChunks}=load(__dirname+'/speech-segments.ts');
 const make=(durations,gaps,lead=.12,tail=.19)=>{
  const sr=24000,a=new Float32Array(Math.round((lead+tail+durations.reduce((x,y)=>x+y,0)+gaps.reduce((x,y)=>x+y,0))*sr));
  let pos=lead;for(let i=0;i<durations.length;i++){for(let n=Math.round(pos*sr);n<Math.round((pos+durations[i])*sr);n++)a[n]=.35*Math.cos(2*Math.PI*180*n/sr);pos+=durations[i]+(gaps[i]??0);}return encode(sr,a);
 };
 const jp=make([1,1,1],[.7,.8]);
 const out=alignZeroShotParts(make([.9,1.1,.9],[.3,.3]),jp);
 assert.equal(out.meta.status,'correct');assert.equal(out.meta.requiredParts,3);
 assert.equal(decode(out.audio).samples.length,decode(jp).samples.length);
 const reference=speechChunks(jp,.5),actual=speechChunks(out.audio,.25,out.meta.splitRegions);
 assert.equal(actual.chunks.length,3);
 const center=(parts)=>{const p=parts.chunks[1];return (p.start+p.end)/2/parts.wave.sampleRate;};
 assert.ok(Math.abs(center(reference)-center(actual))<.011);
 assert.equal(alignZeroShotParts(wav(1,.3,1),jp),null);
 assert.equal(alignZeroShotParts(make([1,1,1],[.3,.3]),wav(1,1,1)),null);
});

test('缩放后按每段自己的系数检测，组内240ms停顿不重新拆开，段间250ms不放大',()=>{
 const {speechChunks}=load(__dirname+'/speech-segments.ts');
 const {partSplitRegions}=load(__dirname+'/auto-run-part-alignment.ts');
 const sr=24000;
 const bodyA=decode(wav(.4,.276,.4,sr,0,0)).samples;
 const bodyB=decode(wav(.4,.204,.4,sr,0,0)).samples;
 // 将段间静音放在10ms网格上，避免恰好250ms被窗边缘量化成240ms。
 const lead=.104;
 const regions=partSplitRegions(lead,[bodyA,bodyB],sr,[.25],[1.15,.85]);
 const a=new Float32Array(Math.round((lead+bodyA.length/sr+.25+bodyB.length/sr+.1)*sr));
 a.set(bodyA,Math.round(lead*sr));a.set(bodyB,Math.round((lead+bodyA.length/sr+.25)*sr));
 const audio=encode(sr,a);
 assert.equal(speechChunks(audio).chunks.length,3);
 assert.equal(speechChunks(audio,.25,regions).chunks.length,2);
 // 真正超出缩放后门槛的片内停顿仍要拆开，不能只相信旧的两段标记。
 const bad=wav(.4,.34,.4,sr,0,0);
 assert.equal(speechChunks(bad,.25,[{startSeconds:0,endSeconds:2,factor:1.15}]).chunks.length,2);
});

test('已合并正文拉长后，候选检测与最终组装都沿用逐段门槛且保持等长',()=>{
 const {speechChunks}=load(__dirname+'/speech-segments.ts');
 const sr=24000;
 const body=decode(wav(.45,.24,.45,sr,0,0)).samples;
 const cn=new Float32Array(Math.round((.1+2*body.length/sr+.7+.1)*sr));
 cn.set(body,Math.round(.1*sr));cn.set(body,Math.round((.1+body.length/sr+.7)*sr));
 const reference=wav(1.32,.7,1.32,sr,.1,.1);
 const aligned=alignParts(encode(sr,cn),reference);
 assert.equal(aligned.meta.parts.length,2);
 assert.equal(aligned.meta.parts[0].factor,1.15);
 assert.ok(speechChunks(aligned.audio).chunks.length>2);
 assert.equal(speechChunks(aligned.audio,.25,aligned.meta.splitRegions).chunks.length,2);
 const final=assembleParts(reference,aligned.audio,plan,[],0,reference,aligned.meta.splitRegions);
 assert.equal(decode(final.audio).samples.length,decode(reference).samples.length);
 assert.equal(speechChunks(final.audio,.25,final.fit.splitRegions).chunks.length,2);
 // 最终原声首留白与参考裁边不同，重组会改变检测窗相位，不能又拆开已缩放的内部停顿。
 for(const lead of [.061,.073,.127]){
  const fullJapanese=wav(1.32,.7,1.32,sr,lead,.19);
  const shifted=assembleParts(fullJapanese,aligned.audio,plan,[],0,reference,aligned.meta.splitRegions);
  assert.equal(speechChunks(shifted.audio,.25,shifted.fit.splitRegions).chunks.length,2);
 }
 // 模拟裁掉首部50ms，区域也向左平移，仍然正确识别。
 const trimmed=encode(sr,decode(aligned.audio).samples.subarray(.05*sr));
 const regions=aligned.meta.splitRegions.map(r=>({...r,startSeconds:r.startSeconds-.05,endSeconds:r.endSeconds-.05}));
 assert.equal(speechChunks(trimmed,.25,regions).chunks.length,2);
});
test('改稿上下文使用同一反馈函数，移除旧候选波形评分表，保留原始日文和分片协议',async()=>{
 const rhythm=load(__dirname+'/auto-run-two-parts.ts');
 const {resolvePromptMessages}=require('./prompt-test-store.cjs');
 await rhythm.withTwoPartContext(async()=>{
  rhythm.setReference(wav(1,.6,1),{words:[]},'固定原日文',{subtitleRestore:{preserved:[]}});
  rhythm.setMeaningAnchor({japanese:'固定原日文',chinese:'固定原中文'});
  rhythm.rememberRhythm('OLD_AUDIO_SCORE',wav(1,.6,1),'旧长稿');
  rhythm.rememberAttempt({draftId:'长稿',script:'旧长稿',requiredChecks:['text','beat'],measurement:{draftId:'长稿',audioId:'旧音频',netRate:7.5,text:{pass:true},beat:{enabled:true,ratio:.55,low:.85,high:1.15}}});
  const messages=await resolvePromptMessages(rhythm.performanceRewriteMessages([{role:'system',content:'原任务协议'}],'two-parts-repair'));
  const text=messages.map(m=>m.content).join('\n');
  assert.match(text,/已有的尝试和出现的问题/);assert.match(text,/退回原因：字数过多/);assert.match(text,/建议改进/);assert.match(text,/固定原日文/);assert.match(text,/固定原中文/);
  assert.doesNotMatch(text,/OLD_AUDIO_SCORE|"normalizedRatio"|"score":/);
  const pick=await resolvePromptMessages(rhythm.performanceRewriteMessages([{role:'system',content:'择优'}],'rhythm-pick'));
  assert.match(pick.map(m=>m.content).join('\n'),/OLD_AUDIO_SCORE/); // 合格音频择优仍保留真实节奏证据。
 });
});
test('四并发历史退回原因隔离，两个任务不得互相借用旧稿',async()=>{
 const rhythm=load(__dirname+'/auto-run-two-parts.ts');
 await Promise.all(Array.from({length:4},(_,i)=>rhythm.withTwoPartContext(async()=>{
  rhythm.rememberAttempt({draftId:'稿'+i,script:'本任务台词'+i,requiredChecks:['text','beat'],measurement:{draftId:'稿'+i,audioId:'音频'+i,netRate:7.5,text:{pass:true},beat:{enabled:true,ratio:.55,low:.85,high:1.15}}});
  await new Promise(r=>setTimeout(r,4-i));
  const text=rhythm.attemptHistoryText();assert.match(text,new RegExp('本任务台词'+i));
  for(let j=0;j<4;j++)if(j!==i)assert.doesNotMatch(text,new RegExp('本任务台词'+j));
 })));
});

test('分段改稿注入程序分档；择优任务不收到改稿指令',async()=>{
 const rhythm=load(__dirname+'/auto-run-two-parts.ts');
 await rhythm.withTwoPartContext(async()=>{
  const script='原有准确表达\n第二段需要补足';
  rhythm.rememberAttempt({draftId:'当前稿',script,requiredChecks:['text','parts','length','beat'],measurement:{draftId:'当前稿',audioId:'本次音频',netRate:7.5,text:{pass:true},hardSpeed:{enabled:true,pass:true},parts:{required:2,actual:2,checks:[{index:1,status:'warning',deltaSeconds:.1},{index:2,status:'error',deltaSeconds:-.5}]},length:{pass:false,deltaSeconds:-.4},beat:{enabled:true,ratio:1,low:.85,high:1.15}}});
  const messages=rhythm.performanceRewriteMessages([{role:'user',content:'',promptValues:{input_json:JSON.stringify({current:script})}}],'two-parts-repair');
  const directive=messages.find(m=>m.content.includes('程序裁定的本轮改稿范围'));
  assert.ok(directive);assert.match(directive.content,/timing-rewrite/);assert.match(directive.content,/不要被最小改动限制住/);assert.match(directive.content,/优先保留原游戏中文字幕/);
  const fresh=rhythm.performanceRewriteMessages([{role:'user',content:'',promptValues:{input_json:JSON.stringify({current:'尚未合成的新稿'})}}],'two-parts-repair');
  assert.doesNotMatch(fresh.find(m=>m.content.includes('程序裁定')).content,/"mode":"timing-rewrite"/);
  assert.ok(!rhythm.performanceRewriteMessages([{role:'system',content:'择优'}],'rhythm-pick').some(m=>m.content.includes('程序裁定')));
 });
});

test('保留原声与正文相接且偏短时，暴露正文内真实静音补齐，不重生成或缩放声音',()=>{
 const tone=seconds=>encode(24000,new Float32Array(Math.round(seconds*24000)).fill(.35));
 const jp=wav(.5,.5,1,24000,0,0),cn=wav(.3,.4,.3,24000,0,0);
 const emotion={enabled:true,onomatopoeia:[{startMs:0,endMs:500}],ambient:[],speech:[{startMs:500,endMs:2000}]};
 const pieces=[{src:'ono',index:0},{src:'tts',startMs:0,endMs:null}];
 const result=assembleParts(jp,cn,emotion,pieces,2,jp);
 assert.equal(decode(result.audio).samples.length,decode(jp).samples.length);
 assert.equal(result.fit.segments.find(x=>x.kind==='onomatopoeia').packed_s,.5);
 const silence=result.fit.segments.filter(x=>x.kind==='silence').reduce((n,x)=>n+x.packed_s,0);
 assert.ok(Math.abs(silence-.9)<.02);assert.ok(Object.values(result.fit.scales).every(x=>x===1));
 // 没有真实停顿时不凭空塞停顿；过长时也不截声音。
 assert.throws(()=>assembleParts(jp,tone(1),emotion,pieces,2,jp),PartAssemblyError);
 assert.throws(()=>assembleParts(jp,tone(1.6),emotion,pieces,2,jp),PartAssemblyError);
});
