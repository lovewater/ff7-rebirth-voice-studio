const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const m=new Module(__filename);
m.require=id=>id==='./alignment-transients'?require('./alignment-transients.ts'):require(id);
m._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/reading-span.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,`${__dirname}/reading-span.ts`);
const {measureReadingSpan:measure,compareReadingSpans:compare,READING_SPAN_METRIC_VERSION}=m.exports;
const wave=(parts,sr=1000)=>({sampleRate:sr,samples:Float32Array.from(parts.flatMap(([n,a])=>Array(n).fill(a)))});
const rule={low:.85,high:1.15};
test('然后到我们之间超过200ms的自然停顿计入单句，补首尾空白不改朗读时长',()=>{
 const body=wave([[420,.5],[300,0],[1414,.5]]),padded=wave([[118,0],[420,.5],[300,0],[1414,.5],[254,0]]);
 assert.equal(measure(body).readingSeconds,2.134);assert.equal(measure(padded).readingSeconds,2.134);
 const jp=measure(wave([[2227,.5]])),cn=measure(padded),c=compare(jp,cn,rule);
 assert.equal(c.pass,true);assert.ok(Math.abs(c.spanRatio-.95824)<.00001);assert.equal(c.metricVersion,READING_SPAN_METRIC_VERSION);
});
for(const count of [2,3])test(`${count}段：段内停顿计时、段间留白不计，逐段对比`,()=>{
 const regions=Array.from({length:count},(_,i)=>({startSeconds:i*2,endSeconds:i*2+1}));
 const audio=wave(Array.from({length:count},(_,i)=>[[400,.5],[300,0],[300,.5],...(i<count-1?[[1000,0]]:[])]).flat());
 const m=measure(audio,regions);assert.equal(m.parts.length,count);assert.equal(m.readingSeconds,count);assert.equal(m.gapSeconds,count-1);assert.equal(compare(m,m,rule).pass,true);
});
test('整句跨度或分段总和一致不能掩盖一段短一段长',()=>{
 const jp={startMs:0,endMs:5000,readingSeconds:4,gapSeconds:1,parts:[{index:1,startMs:0,endMs:2000,spanMs:2000},{index:2,startMs:3000,endMs:5000,spanMs:2000}]};
 const cn={...jp,parts:[{index:1,startMs:0,endMs:1000,spanMs:1000},{index:2,startMs:2000,endMs:5000,spanMs:3000}]};
 const c=compare(jp,cn,rule);assert.equal(c.spanRatio,1);assert.equal(c.ratioPass,true);assert.equal(c.pass,false);assert.ok(c.parts.every(p=>!p.pass));
});
test('仅延长段间留白不能让偏短的正文变合格；缺段和纯静音拒绝',()=>{
 const jp=measure(wave([[1000,.5],[500,0],[1000,.5]]),[{startSeconds:0,endSeconds:1},{startSeconds:1.5,endSeconds:2.5}]);
 const cn=measure(wave([[500,.5],[1500,0],[500,.5]]),[{startSeconds:0,endSeconds:.5},{startSeconds:2,endSeconds:2.5}]);
 assert.equal(compare(jp,cn,rule).pass,false);assert.equal(compare(jp,measure(wave([[2500,.5]])),rule).partCountPass,false);
 assert.equal(measure(wave([[2000,0]])),null);assert.equal(compare(jp,null,rule).pass,false);
});
test('短句150ms绝对容差及逐段300ms警告沿用，边缘裁切后的区域安全限定到音频',()=>{
 const a=measure(wave([[500,.5]])),b=measure(wave([[360,.5]]));assert.equal(compare(a,b,rule).pass,false);assert.equal(compare(a,b,{...rule,absoluteToleranceMs:150}).pass,true);
 assert.equal(measure(wave([[1000,.5]]),[{startSeconds:-.01,endSeconds:1.01}]).readingSeconds,1);
 const reference=measure(wave([[1000,.5],[500,0],[1000,.5]]),[{startSeconds:0,endSeconds:1},{startSeconds:1.5,endSeconds:2.5}]);
 const candidate=measure(wave([[800,.5],[500,0],[1000,.5]]),[{startSeconds:0,endSeconds:.8},{startSeconds:1.3,endSeconds:2.3}]);
 assert.equal(compare(reference,candidate,rule).pass,true);
});
