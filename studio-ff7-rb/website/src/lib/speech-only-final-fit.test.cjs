/* eslint-disable @typescript-eslint/no-require-imports */
const { test }=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const cache=new Map();
function load(name){
 if(!name.startsWith('.'))return require(name);
 if(name.endsWith('.json'))return require(path.resolve(__dirname,name));
 if(name==='./db')return {sql:()=>{throw Error('DSP单测禁止数据库调用')}};
 const filename=path.resolve(__dirname,name+'.ts');
 if(cache.has(filename))return cache.get(filename).exports;
 const m=new Module(filename);cache.set(filename,m);m.require=load;
 m._compile(ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);return m.exports;
}
const {spliceMix,wavDuration}=load('./audio-splice');
const {encodeWavMono,decodeWavMono}=load('./wav-stretch');
const wave=(head,body,tail)=>encodeWavMono(1000,Float32Array.from([...Array(head).fill(0),...body,...Array(tail).fill(0)]));
const sound=n=>Array(n).fill(.5);
const jp=wave(6,sound(3669),77);
const plan={onomatopoeia:[],ambient:[],speech:[{startMs:6,endMs:3675}]};
const pieces=[{src:'tts',startMs:0,endMs:null}];
test('BAD2400-like 500ms shortage reaches final ±200ms tolerance by bounded speech stretch, not tail padding',()=>{
 const input=wave(0,sound(3168),0), before=Buffer.from(input);
 const result=spliceMix(jp,input,plan,pieces,3.752);
 assert.equal(result.fit.step,'speech');
 assert.equal(result.fit.scales['tts-whole'],1.1);
 assert.equal(result.fit.scales['edge-lead'],1);
 assert.equal(result.fit.scales['edge-tail'],1);
 assert.equal(result.ok,true);
 assert.ok(wavDuration(result.audio)>=3.552 && wavDuration(result.audio)<3.752);
 assert.ok(Math.abs(wavDuration(result.audio)-result.fit.actual_s)<.002);
 assert.deepEqual(input,before);
});
test('too-short output remains failed after maximal stretch; cannot pad silence to fake a pass',()=>{
 const result=spliceMix(jp,wave(0,sound(2200),0),plan,pieces,3.752);
 assert.equal(result.ok,false);
 assert.equal(result.fit.scales['tts-whole'],1.1);
 assert.ok(wavDuration(result.audio)<3);
});
test('too-long output cannot shrink beyond the existing 90% floor',()=>{
 const result=spliceMix(jp,wave(0,sound(4400),0),plan,pieces,3.752);
 assert.equal(result.ok,false);
 assert.equal(result.fit.scales['tts-whole'],.9);
});
test('already fitting audio keeps all internal pause samples and fixed Japanese edge silence',()=>{
 const input=wave(100,[...sound(1000),...Array(400).fill(0),...sound(2269)],200);
 const result=spliceMix(jp,input,plan,pieces,3.752);
 assert.equal(result.ok,true);
 assert.equal(result.fit.scales['tts-whole'],1);
 const samples=decodeWavMono(result.audio).samples;
 assert.equal(samples.length,3752);
 assert.ok([...samples.slice(1006,1406)].every(x=>x===0));
 assert.ok([...samples.slice(0,6),...samples.slice(-77)].every(x=>x===0));
});
test('multiple Chinese clauses do not duplicate or drop audio when no original FX needs insertion',()=>{
 const result=spliceMix(jp,wave(0,sound(3669),0),plan,[{src:'tts',startMs:0,endMs:1500},{src:'tts',startMs:1500,endMs:null}],3.752);
 assert.equal(result.ok,true);
 assert.equal(result.fit.segments.filter(s=>s.kind==='speech').length,1);
 assert.equal(wavDuration(result.audio),3.752);
});

test('selected single piece is stretched even when its original error was already within 200ms',()=>{
 const result=spliceMix(jp,wave(0,sound(3500),0),plan,pieces,3.752);
 assert.equal(result.fit.step,'speech');
 assert.ok(result.fit.scales['tts-whole']>1);
 assert.ok(Math.abs(wavDuration(result.audio)-3.752)<.002);
});
