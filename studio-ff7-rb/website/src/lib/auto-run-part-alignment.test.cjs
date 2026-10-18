/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const cache=new Map();function load(file){if(cache.has(file))return cache.get(file).exports;const m=new Module(file);cache.set(file,m);m.require=id=>id.startsWith('./')?load(path.resolve(path.dirname(file),id+'.ts')):require(id);m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);return m.exports;}
const {alignParts,assembleParts,PartAssemblyError}=load(__dirname+'/auto-run-part-alignment.ts');
const {encodeWavMono:encode,decodeWavMono:decode}=load(__dirname+'/wav-stretch.ts');
function wav(first,gap,second,sr=24000,lead=.1,tail=.1){const a=new Float32Array(Math.round((lead+first+gap+second+tail)*sr));for(const [x,y]of[[lead,lead+first],[lead+first+gap,lead+first+gap+second]])for(let i=Math.round(x*sr);i<Math.round(y*sr);i++)a[i]=.35*Math.cos(2*Math.PI*180*i/sr);return encode(sr,a);}
const plan={enabled:false,onomatopoeia:[],ambient:[],speech:[]};
test('入口350ms与候选250ms分开；短停顿不误入，手工编辑默认250ms不变',()=>{
 const {singleInternalGap}=load(__dirname+'/gap-only-align.ts');
 assert.equal(alignParts(wav(1,.4,1),wav(1,.34,1)),null);
 assert.ok(alignParts(wav(1,.25,1),wav(1,.35,1)));
 assert.ok(singleInternalGap(decode(wav(1,.25,1))));
});
test('正确、警告、错误以缩放后的逐段余差区分，总长相等不能掩盖错误',()=>{
 const ref=wav(1,.8,1);
 assert.equal(alignParts(wav(1,.3,1),ref).meta.status,'correct');
 const warning=alignParts(wav(.65,.3,1),ref);
 assert.equal(warning.meta.status,'warning');assert.equal(warning.meta.pass,true);
 const error=alignParts(wav(.4,.3,1),ref);
 assert.equal(error.meta.status,'error');assert.equal(error.meta.pass,false);
 for(const p of warning.meta.parts)assert.ok(p.factor>=.85&&p.factor<=1.15);
});
test('单段余差均警告但放不下250ms间隔，升级错误',()=>{
 const result=alignParts(wav(1.4,.3,1.4),wav(1,.35,1));
 assert.equal(result.meta.status,'error');assert.equal(result.meta.pass,false);
 assert.ok(result.meta.parts.every(x=>x.status==='warning'));
});
test('最终按完整JP重新分配中间间隔，采样率不同也等长，不整体再拉伸',()=>{
 const jp=wav(1,.8,1,24000,.12,.18),reference=wav(1,.8,1,24000,.001,.001);
 const aligned=alignParts(wav(.9,.3,1.1,44100),reference);
 const out=assembleParts(jp,aligned.audio,plan,[],99,reference);
 assert.equal(decode(out.audio).samples.length,Math.round(decode(jp).samples.length*44100/24000));
 assert.equal(out.fit.scales.body,1);assert.equal(out.ok,true);
});
test('候选逐段只是警告，最终却不能等长时必须抛错误，不能默默作为合格成品',()=>{
 const jp=wav(1,.35,1),cn=wav(1.1,.25,1.1);
 assert.throws(()=>assembleParts(jp,cn,plan,[],2.55,jp),PartAssemblyError);
});
test('情绪原声与单段正文只调中间留白，最终必须等长',()=>{
 const jp=wav(.4,.9,.8),cn=encode(24000,decode(wav(.8,0,0)).samples.subarray(0,24000));
 const emotion={enabled:true,onomatopoeia:[{startMs:0,endMs:500,text:'ううん'}],ambient:[],speech:[{startMs:1400,endMs:2200,text:'ぜんぶ'}]};
 const out=assembleParts(jp,cn,emotion,[{src:'ono',index:0},{src:'tts',startMs:0,endMs:null}],2.3,jp);
 assert.ok(Math.abs(decode(out.audio).samples.length-decode(jp).samples.length)<=1);
 assert.ok(Object.values(out.fit.scales).every(x=>x===1));
});
test('四并发固定原意与节奏上下文互不串句，每轮重新附带原始日中字幕',async()=>{
 const rhythm=load(__dirname+'/auto-run-two-parts.ts');
 await Promise.all(Array.from({length:4},(_,i)=>rhythm.withTwoPartContext(async()=>{
  rhythm.setMeaningAnchor({japanese:'原日文'+i,chinese:'原中文'+i,earliestDialogue:[{japanese:'前句',chinese:'前文'}]});
  rhythm.setReference(wav(1,.8,1),{words:[]},'原日文'+i,{subtitleRestore:{preserved:[]}});
  await new Promise(r=>setTimeout(r,4-i));
  for(let round=0;round<3;round++){
   const messages=rhythm.performanceRewriteMessages([{role:'user',content:'最新稿'+round}],'two-parts-repair');
   const anchor=JSON.parse(messages.find(m=>m.promptKey==='two-parts.meaning-anchor').promptValues.input_json);
   assert.equal(anchor.chinese,'原中文'+i);assert.equal(anchor.japanese,'原日文'+i);
   assert.ok(messages.some(m=>m.promptKey==='two-parts.rhythm-context'));
  }
 })));
});
