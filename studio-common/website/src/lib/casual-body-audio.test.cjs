/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript'),crypto=require('node:crypto');
const m=new Module(__filename);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/casual-body-audio.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
const {normalizeCasualBodyWav:normalize,inspectCasualBodyWav:inspect}=m.exports;
function wave(rate=22050,channels=1,bits=16,format=1,frames=Math.round(rate*.37)) {
 const block=channels*bits/8,b=Buffer.alloc(44+frames*block);
 b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(format,20);b.writeUInt16LE(channels,22);
 b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*block,28);b.writeUInt16LE(block,32);b.writeUInt16LE(bits,34);b.write('data',36);b.writeUInt32LE(frames*block,40);
 for(let i=0;i<frames;i++)for(let c=0;c<channels;c++) {
  const v=Math.sin(i/rate*2*Math.PI*440)*.25,at=44+i*block+c*bits/8;
  if(format===3)b.writeFloatLE(v,at);else if(bits===16)b.writeInt16LE(Math.round(v*32767),at);else if(bits===24)b.writeIntLE(Math.round(v*8388607),at,3);
 }
 return b;
}
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
test('IndexTTS native 22050 PCM becomes traceable 24k before verification without changing source bytes',async()=>{
 const input=wave(),before=Buffer.from(input),r=await normalize(input);
 assert.equal(r.changed,true);assert.deepEqual(input,before);assert.equal(r.sourceSha256,hash(input));assert.equal(r.normalizedSha256,hash(r.audio));assert.notEqual(r.sourceSha256,r.normalizedSha256);
 assert.equal(r.sourceFormat.sample_rate,22050);assert.equal(r.normalizedFormat.sample_rate,24000);assert.equal(r.normalizedFormat.channels,1);assert.equal(r.normalizedFormat.bits_per_sample,16);
 assert.ok(Math.abs(r.sourceFormat.duration_s-r.normalizedFormat.duration_s)<=1/24000);
});
test('canonical WAV keeps exact positive and negative LSBs and original buffer/SHA',async()=>{
 const input=wave(24000);input.writeInt16LE(1,44);input.writeInt16LE(-1,46);input.writeInt16LE(32767,48);input.writeInt16LE(-32768,50);
 const r=await normalize(input);assert.equal(r.changed,false);assert.equal(r.audio,input);assert.equal(r.sourceSha256,r.normalizedSha256);assert.equal(r.audio.readInt16LE(44),1);assert.equal(r.audio.readInt16LE(48),32767);
});
test('legal PCM24 stereo and float32 WAV are converted to the same assembly contract',async()=>{
 for(const input of [wave(44100,2,24),wave(48000,2,32,3),wave(24000,2)]) {
  const r=await normalize(input);assert.equal(r.changed,true);assert.equal(r.normalizedFormat.format_tag,1);assert.equal(r.normalizedFormat.sample_rate,24000);assert.equal(r.normalizedFormat.channels,1);assert.equal(r.normalizedFormat.bits_per_sample,16);
  assert.ok(Math.abs(r.sourceFormat.duration_s-r.normalizedFormat.duration_s)<=1/24000);
  assert.ok(r.audio.subarray(78).some(v=>v!==0));
 }
});
test('format duration is actual frames including streaming headers and rejects incomplete data',async()=>{
 const input=wave(24000),stream=Buffer.from(input);stream.writeUInt32LE(0xffffffff,4);stream.writeUInt32LE(0xffffffff,40);
 assert.deepEqual(inspect(stream),inspect(input));assert.equal((await normalize(stream)).audio,stream);
 const broken=Buffer.from(input);broken.writeUInt32LE(input.length,40);await assert.rejects(normalize(broken),/超出/);
 await assert.rejects(normalize(input.subarray(0,input.length-1)),/超出/);
 const frame=Buffer.from(input);frame.writeUInt32LE(frame.length-45,40);await assert.rejects(normalize(frame),/完整PCM/);
});
