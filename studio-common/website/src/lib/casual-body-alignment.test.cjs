/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript'),crypto=require('node:crypto');
const cache={};function load(name){if(cache[name])return cache[name].exports;const m=new Module(__filename);cache[name]=m;m.require=id=>id==='./tts-pronunciation-db'||id==='./rubberband-browser'?{}:id.startsWith('./')?load(id.slice(2)):require(id);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/'+name+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);return m.exports;}
const {alignCasualBodyToReference:align}=load('casual-body-alignment'),{encodeWavMono:encode,decodeWavMono:decode}=load('wav-stretch'),browser=load('audio-edit');
function wave(sr,seconds,blocks){const samples=new Float32Array(Math.round(seconds*sr));for(const [s,e,v]of blocks)samples.fill(v,Math.round(s*sr),Math.round(e*sr));return encode(sr,samples);}
function buffer(samples,sr){return {sampleRate:sr,length:samples.length,numberOfChannels:1,getChannelData:()=>samples};}
const context={createBuffer:(_channels,length,sr)=>buffer(new Float32Array(length),sr)};
for(const sr of [1000,22050,24000,44100,48000])test(`same-rate browser button and automatic WAV output match byte for byte at ${sr}Hz`,()=>{
 const input=wave(sr,1.1,[[.07,.08,.06],[.2,.7,.9]]),reference=wave(sr,.9,[[.06,.07,.06],[.18,.65,.9]]),sourceBefore=Buffer.from(input),referenceBefore=Buffer.from(reference);
 const ref=decode(reference),source=decode(input),bounds=browser.speechBounds(ref.samples,sr),target=ref.samples.length/sr;
 const button=browser.alignToJpSlot(context,buffer(source.samples,sr),{start:bounds.start/sr,dur:target}),automatic=align(input,reference,target);
 assert.deepEqual(automatic.audio,encode(sr,button.getChannelData(0)));assert.deepEqual(input,sourceBefore);assert.deepEqual(reference,referenceBefore);
 assert.equal(automatic.meta.startSeconds,bounds.start/sr);assert.equal(automatic.meta.boundaryPeakRatio,.05);assert.match(automatic.meta.transientPolicy,/isolated-low-peak/);
 assert.ok(Math.abs(automatic.meta.afterDuration-target)<=1/sr);assert.equal(automatic.meta.sourceSha256,crypto.createHash('sha256').update(input).digest('hex'));
});
test('authorized button padding fills the slot, while real speech overrun is retained for duration/compression checks',()=>{
 const sr=24000,reference=wave(sr,1,[[.1,.8,.8]]);
 const short=align(wave(sr,.3,[[.05,.2,.8]]),reference,1);assert.equal(short.meta.afterDuration,1);assert.ok(short.meta.afterDuration>short.meta.beforeDuration);
 const long=align(wave(sr,1.5,[[.1,1.4,.8]]),reference,1);assert.ok(long.meta.afterDuration>1.2);assert.equal(long.meta.afterDuration,1.4);
});
test('invalid/no-voice references and budget mismatch cannot fabricate successful alignment',()=>{
 const a=wave(24000,1,[[.1,.5,.8]]),zero=wave(24000,1,[]);
 assert.throws(()=>align(a,zero,1),/开口/);assert.throws(()=>align(zero,a,1),/听不到/);
 for(const target of [.5,NaN,Infinity,-1])assert.throws(()=>align(a,a,target),/预算/);
});
test('cleaned body alignment leaves both Japanese edge components byte-exact and respects full original duration',()=>{
 const {assembleCasualOriginalEdges:assemble}=load('casual-audio-cleanup'),sr=24000,jp=wave(sr,1,[[0,.2,.6],[.2,.7,.8],[.7,1,-.6]]),ref=wave(sr,.5,[[.05,.45,.8]]);
 const body=align(wave(sr,.8,[[.2,.5,.8]]),ref,.5),p={version:1,enabled:true,sampleRate:sr,sourceFrames:sr,bodyStartFrame:4800,bodyEndFrame:16800,sourcePcmSha256:crypto.createHash('sha256').update(jp.subarray(44)).digest('hex'),preserved:[{side:'head',startFrame:0,endFrame:4800,kind:'nonverbal'},{side:'tail',startFrame:16800,endFrame:sr,kind:'nonverbal'}]};
 const out=assemble(jp,body.audio,p);assert.equal(out.metadata.pcmExact,true);assert.equal(decode(out.audio).samples.length,sr);
 assert.deepEqual(out.audio.subarray(44),Buffer.concat([jp.subarray(44,44+4800*2),body.audio.subarray(44),jp.subarray(44+16800*2)]));
});
