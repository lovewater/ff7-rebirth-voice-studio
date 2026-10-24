const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const m=new Module(__filename);
m.require=id=>{
 if(id==='./auto-run-rules')return require('./auto-run-rules.ts');
 if(['./speech-part-timeline','./alignment-transients'].includes(id)){const t=new Module(__filename);t._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/${id.slice(2)}.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);return t.exports;}
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
test('单间隙入口保持严格，手动中文两段允许日文多段',()=>{
 const plain=wave(1000,[[.6,0],[1,1],[.7,0]]),multi=wave(1000,[[.3,1],[.3,0],[.3,1],[.3,0],[.3,1]]);
 assert.equal(detect(plain),null);assert.equal(detect(multi),null);assert.equal(plan(jp(),plain),null);assert.equal(plan(multi,cn()).partCount,2);
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
test('中文两段可归并日文；中文四段或三段装不下仍拒绝',()=>{
 const three=wave(1000,[[.3,1],[.3,0],[.3,1],[.3,0],[.3,1]]);
 const four=wave(1000,[[.3,1],[.3,0],[.3,1],[.3,0],[.3,1],[.3,0],[.3,1]]);
 const huge=wave(1000,[[1,1],[.3,0],[1,1],[.3,0],[1,1]]);
 assert.equal(plan(three,cn()).partCount,2);assert.equal(plan(four,four),null);assert.equal(plan(three,huge),null);
});
for(const count of [2,3])test(`${count}段对齐忽略前置孤立微弱凸起，不误增段且正文PCM原样复制`,()=>{
 const make=()=>wave(1000,[[.45,0],...[...Array(count)].flatMap((_,i)=>[[.3,1],...(i<count-1?[[.6,0]]:[])]),[.2,0]]);
 const ref=make(),edited=make();for(const at of [90,100,120,139]){ref.samples[at]=.05;edited.samples[at]=.05;}
 // 整句峰值约.806，凸起约6.2%；跨度50ms但累计越线4ms。
 const p=plan(ref,edited),out=align(ref,edited);assert.equal(p.partCount,count);assert.equal(p.leading,450);
 p.parts.forEach((part,i)=>assert.deepEqual(out.slice(p.starts[i],p.starts[i]+part.end-part.start),edited.samples.slice(part.start,part.end)));
});
test('手动中文两段：日文三段取最长停顿为唯一分界，首段贴头、末段贴尾',()=>{
 const ref=wave(1000,[[.1,0],[.3,1],[.27,0],[.4,1],[.84,0],[.5,1],[.2,0]]);
 const edit=wave(1000,[[.2,0],[.6,1],[.7,0],[.4,1],[.1,0]]),before=edit.samples.slice(),p=plan(ref,edit),out=align(ref,edit);
 assert.equal(p.partCount,2);assert.deepEqual(p.referenceGaps,[{start:1070,end:1910}]);
 assert.deepEqual(p.referenceParts,[{start:100,end:1070},{start:1910,end:2410}]);
 assert.equal(p.starts[0],100);assert.equal(p.starts[1]+p.parts[1].end-p.parts[1].start,2410);
 p.parts.forEach((part,i)=>assert.deepEqual(out.slice(p.starts[i],p.starts[i]+part.end-part.start),edit.samples.slice(part.start,part.end)));
 assert.deepEqual(edit.samples,before);assert.equal(out.length,ref.samples.length);
});
test('日文四段也能按最长停顿归两组；同长取首处，首尾静音不竞争',()=>{
 const ref=wave(1000,[[2,0],[.3,1],[.6,0],[.3,1],[.8,0],[.3,1],[.8,0],[.3,1],[2,0]]);
 assert.equal(detect(ref),null); // 自动/旧单间隙入口不接受多段，行为未放宽。
 const p=plan(ref,cn());assert.equal(p.partCount,2);assert.deepEqual(p.referenceGaps,[{start:3200,end:4000}]);assert.equal(p.leading,2000);assert.equal(p.trailing,2000);
});
test('中文三段不反向强行归并：日文两段仍拒绝，日文三段保留原三段策略',()=>{
 const three=wave(1000,[[.3,1],[.3,0],[.3,1],[.3,0],[.3,1]]);
 assert.equal(plan(jp(),three),null);assert.equal(plan(three,three).partCount,3);
});
