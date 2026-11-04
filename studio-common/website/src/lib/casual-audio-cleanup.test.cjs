/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const {spawnSync}=require('node:child_process'),os=require('node:os'),path=require('node:path');
const m=new Module(__filename);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/casual-audio-cleanup.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
const {planCasualAudioCleanup:plan,extractCasualBodyReference:extract,assembleCasualOriginalEdges:assemble,restoreCasualScript:restore,casualCleanupTextMatches:matches}=m.exports;
const SR=24000;
function wav(seconds,blocks=[]){const n=Math.round(seconds*SR),b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(SR,24);b.writeUInt32LE(SR*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(const [s,e,v]of blocks)for(let i=Math.round(s*SR);i<Math.round(e*SR);i++)b.writeInt16LE(v,44+i*2);return b;}
function asr(text,words,other={}){return {text,language:'Japanese',raw:{},alignment:{model:'Qwen/Qwen3-ForcedAligner-0.6B',status:'ok',time_unit:'seconds',items:words.map(([text,start_time,end_time])=>({text,start_time,end_time}))},...other};}
function fixture(){return {audio:wav(2.6,[[.1,.3,12345],[.95,1.5,-11111],[2.2,2.4,7777]]),textJp:'うん こんにちは はは',textZh:'嗯，你好，哈哈！',asr:asr('うん、こんにちは、はは。',[['うん',.1,.25],['こんにちは',.98,1.4],['はは',2.2,2.35]])};}
test('paired independent head/tail are removed together in both languages and restored literally',()=>{
 const input=fixture(),p=plan(input);assert.equal(p.enabled,true);assert.equal(p.bodyTextJp,'こんにちは');assert.equal(p.bodyTextZh,'你好');
 assert.deepEqual(p.preserved.map(x=>[x.side,x.kind]),[['head','nonverbal'],['tail','nonverbal']]);assert.equal(restore(p,p.bodyTextZh),input.textZh);assert.equal(restore(p,'您好'),'嗯，您好，哈哈！');
 const source=input.audio.subarray(44),ref=extract(input.audio,p);assert.deepEqual(ref.subarray(44),source.subarray(p.bodyStartFrame*2,p.bodyEndFrame*2));
 assert.equal(ref.length-44,(p.bodyEndFrame-p.bodyStartFrame)*2);
});
test('composition preserves original signed PCM bytes, order and natural shorter total',()=>{
 const input=fixture(),p=plan(input),body=wav(.7,[[0,.7,123]]),result=assemble(input.audio,body,p),source=input.audio.subarray(44),out=result.audio.subarray(44);
 const head=source.subarray(0,p.bodyStartFrame*2),tail=source.subarray(p.bodyEndFrame*2);
 assert.deepEqual(out,Buffer.concat([head,body.subarray(44),tail]));assert.equal(result.metadata.pcmExact,true);assert.ok(result.metadata.outputFrames<p.sourceFrames);
 assert.equal(result.metadata.bodyFrames,16800);assert.deepEqual(result.metadata.preserved.map(x=>x.frames),[p.bodyStartFrame,p.sourceFrames-p.bodyEndFrame]);
 assert.ok(result.metadata.preserved.every(x=>/^[a-f0-9]{64}$/.test(x.sha256)));
});
test('overlong body refuses to trim speech or stretch original edges; stale source refuses',()=>{
 const input=fixture(),p=plan(input);assert.throws(()=>assemble(input.audio,wav(2),p),/超过/);
 const changed=Buffer.from(input.audio);changed.writeInt16LE(42,44);assert.throws(()=>extract(changed,p),/证据不一致/);
 assert.throws(()=>assemble(changed,wav(.5),p),/证据不一致/);
 const wrongRate=Buffer.from(wav(.5));wrongRate.writeUInt32LE(16000,24);assert.throws(()=>assemble(input.audio,wrongRate,p),/24k/);
});
test('unclassified sound edges need explicit official-source permission and complete text',()=>{
 const input={audio:wav(2.3,[[.1,.3,12000],[.95,1.4,10000],[2,2.2,-9999]]),textJp:'こんにちは',textZh:'你好',asr:asr('こんにちは。',[['こんにちは',1,1.35]])};
 assert.equal(plan(input).enabled,false);
 const p=plan({...input,allowUnclassifiedEdges:true});assert.equal(p.enabled,true);assert.equal(p.bodyTextZh,'你好');assert.deepEqual(p.preserved.map(x=>x.kind),['unclassified','unclassified']);
 assert.equal(plan({...input,allowUnclassifiedEdges:true,textJp:'こんにちは 友達'}).enabled,false);
 assert.equal(restore(p,'你好'),input.textZh);
});
test('missing JP/CN pairing never strips a Chinese interjection or meaningful Japanese word',()=>{
 const samples=[['はい こんにちは','嗯，你好'],['よし こんにちは','好，你好'],['なるほど こんにちは','原来如此，你好'],['ねえ こんにちは','喂，你好'],['ううん こんにちは','不，你好'],['あの こんにちは','啊，你好']];
 for(const [textJp,textZh]of samples){const [head]=textJp.split(' '),input=fixture();input.textJp=textJp;input.textZh=textZh;input.asr=asr(textJp,[[head,.1,.25],['こんにちは',.98,1.4]]);const p=plan(input);assert.equal(p.enabled,false,textJp);assert.equal(p.bodyTextZh,textZh);}
 const input=fixture();input.textZh='你好，朋友！';assert.equal(plan(input).enabled,false);assert.equal(plan(input).bodyTextZh,input.textZh);
});
test('unclassified edges cannot double-read an unpaired Chinese written nonverbal',()=>{
 const input={audio:wav(2.3,[[.1,.3,12000],[.95,1.4,10000],[2,2.2,-9999]]),textJp:'こんにちは',textZh:'嗯，你好，哈哈！',asr:asr('こんにちは。',[['こんにちは',1,1.35]]),allowUnclassifiedEdges:true};
 const p=plan(input);assert.equal(p.enabled,false);assert.equal(p.bodyTextZh,input.textZh);assert.equal(p.preserved.length,0);
 const headOnly=plan({...input,textZh:'嗯，你好'});assert.ok(!headOnly.preserved.some(x=>x.side==='head'));assert.equal(headOnly.bodyTextZh,'嗯，你好');
 for(const textZh of ['咳咳，你好','嗯你好','（咳咳）你好','呜呜，你好','喘，你好']){
  const p=plan({...input,textZh});assert.ok(!p.preserved.some(x=>x.side==='head'),textZh);assert.equal(p.bodyTextZh,textZh);
 }
 for(const textZh of ['你好，咳咳','你好嗯','你好（咳咳）','你好，呜呜']){
  const p=plan({...input,textZh});assert.ok(!p.preserved.some(x=>x.side==='tail'),textZh);assert.equal(p.bodyTextZh,textZh);
 }
});
test('a prefix character inside a word or phrase without separators is never deleted',()=>{
 const input=fixture();input.textJp='うんこんにちは';input.textZh='嗯你好';input.asr=asr('うんこんにちは',[['うん',.1,.25],['こんにちは',.98,1.4]]);
 const p=plan(input);assert.equal(p.enabled,false);assert.equal(p.bodyTextZh,input.textZh);
});
test('incomplete/alternate semantic text and mismatched ASR axis leave all source text and frames intact',()=>{
 for(const modify of [i=>i.textJp='うん こんにちは 友達 はは',i=>i.asr.text='うん さようなら はは',i=>i.asr.alignment.items[1].text='友達',i=>i.textJp='うん 今日 はは']){
  const input=fixture();modify(input);const p=plan(input);assert.equal(p.enabled,false);assert.equal(p.bodyTextZh,input.textZh);assert.equal(p.bodyStartFrame,0);assert.equal(p.bodyEndFrame,p.sourceFrames);assert.deepEqual(extract(input.audio,p),input.audio);
 }
});
test('empty/failed/unsupported axes and invalid word geometry cannot cause cuts',()=>{
 for(const modify of [i=>i.asr.text='',i=>delete i.asr.alignment,i=>i.asr.alignment.status='unsupported_language',i=>i.asr.language='Chinese',i=>i.asr.alignment.time_unit='milliseconds',i=>i.asr.alignment.model='unknown',i=>i.asr.alignment.items[1].end_time=.98,i=>i.asr.alignment.items[1].start_time=-1,i=>i.asr.alignment.items[1].start_time=.1,i=>i.asr.alignment.items[2].end_time=3,i=>i.asr.alignment.items[1].start_time=NaN]){
  const input=fixture();modify(input);const p=plan(input);assert.equal(p.enabled,false);assert.equal(p.bodyTextZh,input.textZh);assert.equal(p.preserved.length,0);
 }
});
test('weak audible speech in a proposed gap prevents head deletion and remains in source reference',()=>{
 const input=fixture();for(let i=Math.round(.3*SR);i<Math.round(.95*SR);i++)input.audio.writeInt16LE(100,44+i*2);
 const p=plan(input);assert.ok(!p.preserved.some(x=>x.side==='head'));assert.ok(p.bodyTextZh.startsWith('嗯'));assert.equal(p.removedChinesePrefix,'');
});
test('no silent cut or too short gaps are conservative no-ops',()=>{
 const input=fixture();for(let i=Math.round(.3*SR);i<Math.round(2.2*SR);i++)input.audio.writeInt16LE(7000,44+i*2);
 const p=plan(input);assert.equal(p.enabled,false);assert.equal(p.bodyTextZh,input.textZh);
});
test('internal sounds are left unchanged instead of guessing bilingual insertion',()=>{
 const input={audio:wav(2.8,[[.1,.6,10000],[1.1,1.4,9000],[2,2.5,11000]]),textJp:'こんにちは 友達',textZh:'你好，朋友',asr:asr('こんにちは 友達',[['こんにちは',.1,.55],['友達',2.05,2.45]]),allowUnclassifiedEdges:true};
 const p=plan(input);assert.equal(p.enabled,false);assert.deepEqual(extract(input.audio,p),input.audio);
});
test('comparison only normalizes width, kana, punctuation and spaces; never homophones or synonyms',()=>{
 assert.equal(matches('「コンニチハ」','こんにちは。'),true);assert.equal(matches('Ａ１２','A12'),true);assert.equal(matches('今日','きょう'),false);assert.equal(matches('こんにちは','こんばんは'),false);assert.equal(matches('','。'),false);
});
test('real FFmpeg stdout WAV terminal size sentinel is supported, finite corrupt chunks rejected',()=>{
 const input=fixture();const result=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','wav','-i','pipe:0','-ac','1','-ar','24000','-c:a','pcm_s16le','-f','wav','pipe:1'],{input:input.audio});
 assert.equal(result.status,0,result.stderr.toString());assert.equal(result.stdout.readUInt32LE(4),0xffffffff);
 const p=plan({...input,audio:result.stdout});assert.equal(p.enabled,true);assert.equal(p.sourceFrames,Math.round(2.6*SR));
 const ref=extract(result.stdout,p);const canonical=extract(input.audio,plan(input));assert.deepEqual(ref,canonical);
 const damaged=Buffer.from(input.audio);damaged.writeUInt32LE(0xfffffffe,40);assert.throws(()=>plan({...input,audio:damaged}),/块超出/);
});
test('cleanup never treats all-zero or purely nonverbal-only audio as a synthesizable body',()=>{
 const input=fixture();input.audio=wav(2.6);assert.equal(plan(input).enabled,false);
 const pure={audio:wav(1,[[.1,.5,5000]]),textJp:'うん',textZh:'嗯',asr:asr('うん',[['うん',.1,.5]])};assert.equal(plan(pure).enabled,false);
});
test('edge-only sound with hallucinated words cannot produce a zero or isolated-spike body reference',()=>{
 const input={audio:wav(2.3,[[.1,.3,12000],[2,2.2,-9999]]),textJp:'はい',textZh:'好的',asr:asr('はい',[['はい',1,1.35]]),allowUnclassifiedEdges:true};
 for(const spikeFrames of [0,1,20]){
  const audio=Buffer.from(input.audio);for(let n=0;n<spikeFrames;n++)audio.writeInt16LE(200,44+SR*2+n*2);
  const p=plan({...input,audio});assert.equal(p.enabled,false);assert.equal(p.bodyStartFrame,0);assert.equal(p.bodyEndFrame,Math.round(2.3*SR));assert.deepEqual(extract(audio,p),audio);
 }
});
test('body activity guard uses local scale and keeps weak real body under loud original edges',()=>{
 const input={audio:wav(2.3,[[.1,.3,30000],[.95,1.4,20],[2,2.2,-29000]]),textJp:'はい',textZh:'好的',asr:asr('はい',[['はい',1,1.35]]),allowUnclassifiedEdges:true};
 const p=plan(input);assert.equal(p.enabled,true);assert.equal(p.evidence.bodyPeak,20);assert.ok(p.evidence.bodyActivityFrames>=SR*.02);
});
test('seekable MP3 decode to real FFmpeg pipe WAV is accepted without floating re-encoding',()=>{
 const input=fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'casual-cleanup-wav-'));
 try{
  const mp3=path.join(dir,'source.mp3');const encoded=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','wav','-i','pipe:0','-c:a','libmp3lame','-q:a','2','-y',mp3],{input:input.audio});assert.equal(encoded.status,0,encoded.stderr.toString());
  const decoded=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-i',mp3,'-ac','1','-ar','24000','-f','wav','pipe:1']);assert.equal(decoded.status,0,decoded.stderr.toString());
  assert.equal(decoded.stdout.readUInt32LE(4),0xffffffff);const p=plan({...input,audio:decoded.stdout});assert.equal(p.enabled,true);assert.equal(p.sourceFrames,Math.round(2.6*SR));
  const ref=extract(decoded.stdout,p);assert.equal(ref.readUInt32LE(40),(p.bodyEndFrame-p.bodyStartFrame)*2);assert.equal(ref.length,44+(p.bodyEndFrame-p.bodyStartFrame)*2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
