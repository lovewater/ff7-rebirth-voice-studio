/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const cache={};function load(name){if(cache[name])return cache[name].exports;const m=new Module(__filename);cache[name]=m;m.require=id=>id==='./tts-pronunciation-db'?{}:id.startsWith('./')?load(id.slice(2)):require(id);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/'+name+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);return m.exports;}
const {planCasualSpeechCompression:plan,compressCasualSpeech:compress}=load('casual-speech-compression'),{encodeWavMono:encode,decodeWavMono:decode}=load('wav-stretch'),{parseWavPcm16:pcm,wavTiming}=load('tts-gpu');
function wave(sr,total,start,end){const samples=new Float32Array(Math.round(total*sr));samples.fill(.4,Math.round(start*sr),Math.round(end*sr));const b=encode(sr,samples);for(let i=0;i<Math.round(start*sr);i++)b.writeInt16LE(1,44+i*2);for(let i=Math.round(end*sr);i<samples.length;i++)b.writeInt16LE(-1,44+i*2);return b;}
test('nonperformance15%: 10total/9speech/1silence minimum8.65, never8.5; boundary follows speech span',()=>{
 const good=plan(10000,1000,{start:400,end:9400},8.65);assert.equal(good.ratio,.85);assert.equal(good.totalRatio,.865);assert.equal(good.targetSpeechFrames,7650);
 assert.equal(plan(10000,1000,{start:400,end:9400},8.5),null);assert.equal(plan(10000,1000,{start:400,end:9400},8.649999),null);
 assert.equal(plan(10000,1000,{start:400,end:9400},8.6509).targetFrames,8650);
});
test('invalid frames, sample rates, boundaries, targets never produce a compression plan',()=>{
 for(const args of [[0,1000,{start:0,end:0},1],[10,0,{start:0,end:9},1],[10,1000,{start:2,end:2},1],[10,1000,{start:-1,end:9},1],[10,1000,{start:0,end:11},1],[10,1000,{start:0,end:9},NaN],[10,1000,{start:0,end:9},Infinity],[10,1000,{start:.1,end:9},.009]])assert.equal(plan(...args),null);
});
for(const sr of [22050,24000,48000])test(`only the speech span is stretched; fixed external signed-LSB PCM and full duration verified at ${sr}Hz`,()=>{
 const input=wave(sr,10,.4,9.4),before=Buffer.from(input),result=compress(input,9.1);assert.ok(result);assert.equal(result.plan.ratio,.9);assert.equal(result.plan.sampleRate,sr);
 const from=pcm(input),to=pcm(result.audio),head=input.subarray(from.dataOffset,from.dataOffset+result.plan.leadingFrames*2),tail=input.subarray(from.dataOffset+(result.plan.leadingFrames+result.plan.speechFrames)*2);
 assert.deepEqual(result.audio.subarray(to.dataOffset,to.dataOffset+head.length),head);assert.deepEqual(result.audio.subarray(result.audio.length-tail.length),tail);
 assert.equal(to.frames,Math.floor(9.1*sr));assert.ok(to.frames/sr<=9.1);assert.equal(result.metadata.externalSilencePcmExact,true);assert.deepEqual(input,before);
 assert.equal(result.plan.targetSpeechFrames,result.plan.targetFrames-result.plan.leadingFrames-result.plan.trailingFrames);
});
test('page speech span includes internal silence and uses raw5% rather than alignment transient filtering',()=>{
 const sr=24000,input=wave(sr,2,.4,1.8);for(let i=0;i<sr*.2;i++)input.writeInt16LE(0,44+Math.round(.9*sr)*2+i*2);
 // A raw5%-visible isolated precursor is part of page speech, even though button detection may ignore it.
 for(let i=Math.round(.1*sr);i<Math.round(.11*sr);i++)input.writeInt16LE(1000,44+i*2);
 const timing=wavTiming(input),r=compress(input,1.9);assert.ok(r);assert.equal(r.plan.speechFrames,Math.round(timing.speech*sr));assert.equal(r.plan.leadingFrames,Math.round(timing.start*sr));
 assert.equal(r.metadata.boundaryPolicy,'wavTiming-raw-peak');assert.match(r.metadata.definition,/including-internal-pauses/);
 assert.ok(r.plan.speechFrames>1.6*sr);
});
test('zero/no-speech input or impossible fixed-silence budget cannot be counted as compression success',()=>{
 assert.equal(compress(encode(24000,new Float32Array(24000)),.9),null);
 const input=wave(24000,10,.4,9.4);assert.equal(compress(input,8.5),null);assert.equal(decode(input).samples.length,240000);
});
test('new nonperformance15% limit preserves both external PCM regions and records the full allowed range',()=>{
 const sr=24000,input=wave(sr,10,.4,9.4),out=compress(input,8.65);assert.ok(out);assert.equal(out.plan.ratio,.85);assert.deepEqual(out.metadata.allowedSpeechRatio,{min:.85,max:1.15});
 const a=pcm(input),b=pcm(out.audio),leading=out.plan.leadingFrames*2,trailing=out.plan.trailingFrames*2;
 assert.deepEqual(out.audio.subarray(b.dataOffset,b.dataOffset+leading),input.subarray(a.dataOffset,a.dataOffset+leading));assert.deepEqual(out.audio.subarray(out.audio.length-trailing),input.subarray(input.length-trailing));
});
