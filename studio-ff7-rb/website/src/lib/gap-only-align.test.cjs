const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const m=new Module(__filename);
m.require=id=>{
 if(id==='./auto-run-rules')return require('./auto-run-rules.ts');
 if(id==='./speech-part-timeline'){const t=new Module(__filename);t._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/speech-part-timeline.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);return t.exports;}
 return require(id);
};
m._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/gap-only-align.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,`${__dirname}/gap-only-align.ts`);
const {singleInternalGap:detect,gapOnlyAlignmentPlan:plan,alignSingleGap:align}=m.exports;
function wave(sr,segments){
 const a=[];for(const [seconds,voiced] of segments)for(let i=0;i<Math.round(seconds*sr);i++)a.push(voiced?((i%2?-.4:.8)+((i%7)*.001)):0);
 return {sampleRate:sr,samples:Float32Array.from(a)};
}
const jp=()=>wave(1000,[[.1,0],[.5,1],[.4,0],[.8,1],[.2,0]]);
const cn=()=>wave(1000,[[.3,0],[.4,1],[.7,0],[.6,1],[.2,0]]);
test('only silence changes: both voice blocks remain bit-for-bit identical and inputs are untouched',()=>{
 const ref=jp(),edit=cn(),before=edit.samples.slice(),p=plan(ref,edit),out=align(ref,edit);
 assert.equal(out.length,ref.samples.length);assert.equal(p.leading,100);assert.equal(p.trailing,200);assert.equal(p.middle,700);
 assert.deepEqual(out.slice(100,500),edit.samples.slice(300,700));
 assert.deepEqual(out.slice(1200,1800),edit.samples.slice(1400,2000));
 assert.ok(out.slice(0,100).every(x=>x===0));assert.ok(out.slice(500,1200).every(x=>x===0));assert.ok(out.slice(1800).every(x=>x===0));assert.deepEqual(edit.samples,before);
});
test('different reference and edit sample rates use seconds for target length and edge silence',()=>{
 const ref=jp(),edit=wave(2000,[[.3,0],[.4,1],[.7,0],[.6,1],[.2,0]]),p=plan(ref,edit);
 assert.equal(p.total,4000);assert.equal(p.leading,200);assert.equal(p.trailing,400);assert.equal(align(ref,edit).length,4000);
});
test('zero or multiple internal long gaps never enable advanced alignment',()=>{
 const plain=wave(1000,[[.6,0],[1,1],[.7,0]]),multi=wave(1000,[[.3,1],[.3,0],[.3,1],[.3,0],[.3,1]]);
 assert.equal(detect(plain),null);assert.equal(detect(multi),null);assert.equal(plan(jp(),plain),null);assert.equal(plan(multi,cn()),null);
});
test('250ms qualifies, shorter gaps do not, exactly 5% peak remains voiced',()=>{
 assert.ok(detect(wave(1000,[[.3,1],[.25,0],[.3,1]])));
 assert.equal(detect(wave(1000,[[.3,1],[.249,0],[.3,1]])),null);
 const a=new Float32Array(1000).fill(.05);a[0]=1;a[999]=1;
 assert.equal(detect({samples:a,sampleRate:1000}),null);
});
test('cannot fit voice blocks: reject rather than trim speech or stretch it',()=>{
 const huge=wave(1000,[[1,1],[.3,0],[1,1]]);
 assert.equal(plan(jp(),huge),null);assert.throws(()=>align(jp(),huge),/两段正文/);
});
test('reject pure silence and invalid samples without exposing advanced alignment',()=>{
 for(const samples of [new Float32Array(),new Float32Array(2000),Float32Array.of(NaN),Float32Array.of(Infinity)])assert.equal(detect({samples,sampleRate:1000}),null);
 assert.equal(detect({...jp(),sampleRate:0}),null);
});
test('三段对话工作流只改留白，中段中心对齐日文中段，原PCM和输入不变',()=>{
 const ref=wave(1000,[[.1,0],[.5,1],[.4,0],[.8,1],[.6,0],[.7,1],[.2,0]]);
 for(const sr of [1000,2000]){
  const edit=wave(sr,[[.3,0],[.4,1],[.3,0],[.6,1],[.3,0],[.5,1],[.2,0]]),before=edit.samples.slice(),p=plan(ref,edit),out=align(ref,edit);
  assert.equal(p.partCount,3);assert.equal(out.length,Math.round(ref.samples.length*sr/1000));
  assert.ok(Math.abs((p.starts[1]+(p.parts[1].end-p.parts[1].start)/2)/sr-1.4)<=1/sr);
  p.parts.forEach((part,i)=>assert.deepEqual(out.subarray(p.starts[i],p.starts[i]+part.end-part.start),edit.samples.subarray(part.start,part.end)));
  assert.deepEqual(edit.samples,before);assert.ok(p.gaps.every(n=>n>=.25*sr));
  assert.equal(p.starts[0],.1*sr);assert.equal(p.starts[2]+p.parts[2].end-p.parts[2].start,3.1*sr);
 }
});
test('两三段不匹配、四段或三段装不下不能启动高级对齐',()=>{
 const three=wave(1000,[[.3,1],[.3,0],[.3,1],[.3,0],[.3,1]]);
 const four=wave(1000,[[.3,1],[.3,0],[.3,1],[.3,0],[.3,1],[.3,0],[.3,1]]);
 const huge=wave(1000,[[1,1],[.3,0],[1,1],[.3,0],[1,1]]);
 assert.equal(plan(three,cn()),null);assert.equal(plan(four,four),null);assert.equal(plan(three,huge),null);
});
