const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const m=new Module(__filename);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/speech-part-timeline.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);const {layoutPartTimeline}=m.exports;
const ref={sampleRate:1000,samples:new Float32Array(6000)},chunks=[{start:100,end:1100},{start:2100,end:3100},{start:4100,end:5100}];
test('三段首段贴头、末段贴尾，中段无论偏长偏短均按JP发声中心对齐',()=>{
 for(const middle of [800,1000,1200]){
  const bodies=[new Float32Array(1000),new Float32Array(middle),new Float32Array(1000)];
  const out=layoutPartTimeline(ref,chunks,1000,bodies),middleStart=100+1000+out.gapsSeconds[0]*1000;
  assert.equal(middleStart+middle/2,2600);
  assert.equal(middleStart+middle+out.gapsSeconds[1]*1000,4100);
  assert.equal(out.samples.length,6000);assert.equal(out.leadingSeconds,.1);assert.equal(out.trailingSeconds,.9);
 }
});
test('中段中心对齐受两边250ms间隔限制时夹到最近可行位置',()=>{
 const out=layoutPartTimeline(ref,chunks,1000,[new Float32Array(2300),new Float32Array(1000),new Float32Array(1000)]);
 assert.ok(out);assert.equal(out.gapsSeconds[0],.25);assert.ok(out.gapsSeconds[1]>=.25);
 assert.equal(out.samples.length,6000);
});
test('两段仍将剩余长度全部分配唯一间隔，不改变原对齐规则',()=>{
 const out=layoutPartTimeline(ref,[chunks[0],chunks[2]],1000,[new Float32Array(800),new Float32Array(1200)]);
 assert.equal(out.leadingSeconds,.1);assert.equal(out.trailingSeconds,.9);assert.deepEqual(out.gapsSeconds,[3]);
 assert.equal(out.samples.length,6000);
});
