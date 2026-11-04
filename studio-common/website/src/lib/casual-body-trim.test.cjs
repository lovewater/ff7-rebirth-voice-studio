/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript'),crypto=require('node:crypto');
const cache={};function load(name){if(cache[name])return cache[name];const m=new Module(__filename);m.require=id=>id.startsWith('./')?load(id.slice(2)):require(id);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/'+name+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);return cache[name]=m.exports;}
const {trimCasualBodyEdges:trim}=load('casual-body-trim');
function wave(seconds=1,blocks=[],channels=1){const sr=24000,frames=Math.round(seconds*sr),b=Buffer.alloc(44+frames*2*channels);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(channels,22);b.writeUInt32LE(sr,24);b.writeUInt32LE(sr*channels*2,28);b.writeUInt16LE(channels*2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);for(const [start,end,value]of blocks)for(let f=Math.round(start*sr);f<Math.round(end*sr);f++)for(let c=0;c<channels;c++)b.writeInt16LE(c===1?-value:value,44+(f*channels+c)*2);return b;}
function exactCrop(input,result){assert.deepEqual(result.audio.subarray(44),input.subarray(44+result.meta.firstFrame*result.meta.channels*2,44+result.meta.endFrame*result.meta.channels*2));}
test('crop only outer silence, retain every internal gap and PCM sample exactly',()=>{
 const input=wave(1,[[.2,.35,10000],[.65,.8,-10000]]),r=trim(input);assert.equal(r.changed,true);exactCrop(input,r);
 assert.equal(r.meta.trimmedLeading,.16);assert.ok(Math.abs(r.meta.trimmedTrailing-.16)<1e-12);
 assert.deepEqual(r.audio.subarray(44+Math.round((.35-.16)*24000)*2,44+Math.round((.65-.16)*24000)*2),Buffer.alloc(.3*24000*2));
});
test('weak leading/trailing raw PCM at 0.1% threshold is protected beyond the proposed 5% guard',()=>{
 const input=wave(1,[[.08,.19,20],[.2,.7,10000],[.71,.88,20]]),r=trim(input);exactCrop(input,r);
 assert.ok(r.meta.firstFrame<=.078*24000);assert.ok(r.meta.endFrame>=.882*24000);
 const removed=Buffer.concat([input.subarray(44,44+r.meta.firstFrame*2),input.subarray(44+r.meta.endFrame*2)]);
 for(let at=0;at<removed.length;at+=2)assert.ok(Math.abs(removed.readInt16LE(at))<r.meta.weakThreshold);
});
test('silence, a lone spike or less than20ms strong activity are byte-identical no-ops',()=>{
 for(const input of [wave(),wave(1,[[.5,.501,10000]]),wave(.02,[[.001,.01,10000]])]){const r=trim(input);assert.equal(r.changed,false);assert.equal(r.audio,input);}
});
test('anti-phase stereo uses actual channel maxima and preserves both channels',()=>{
 const input=wave(1,[[.2,.8,10000]],2),r=trim(input);assert.equal(r.changed,true);assert.equal(r.meta.channels,2);exactCrop(input,r);
});
test('retained signed LSBs and source bytes never pass through float encoding',()=>{
 const input=wave(1,[[.2,.8,10000]]),before=Buffer.from(input);input.writeInt16LE(1,44+12000*2);input.writeInt16LE(-1,44+12001*2);const source=Buffer.from(input),r=trim(input);exactCrop(input,r);assert.deepEqual(input,source);assert.notDeepEqual(input,before);
});
test('trimmed Chinese body can be assembled with both JP edges as exactly three PCM components',()=>{
 const {assembleCasualOriginalEdges:assemble}=load('casual-audio-cleanup');
 const jp=wave(2,[[0,.2,20000],[.2,1.8,9000],[1.8,2,-20000]]),body=wave(1,[[.2,.8,10000]]),r=trim(body);
 const p={version:1,enabled:true,sampleRate:24000,sourceFrames:48000,bodyStartFrame:4800,bodyEndFrame:43200,sourcePcmSha256:crypto.createHash('sha256').update(jp.subarray(44)).digest('hex'),preserved:[{side:'head',startFrame:0,endFrame:4800,kind:'nonverbal'},{side:'tail',startFrame:43200,endFrame:48000,kind:'nonverbal'}]};
 const out=assemble(jp,r.audio,p);assert.equal(out.metadata.pcmExact,true);assert.deepEqual(out.audio.subarray(44),Buffer.concat([jp.subarray(44,44+4800*2),r.audio.subarray(44),jp.subarray(44+43200*2)]));
});
