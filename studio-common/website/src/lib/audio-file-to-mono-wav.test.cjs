/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),Module=require('node:module'),ts=require('typescript');
function load(name,dependencies={}) {
 const m=new Module(__filename);
 m.require=id=>Object.hasOwn(dependencies,id)?dependencies[id]:id.startsWith('./')?{}:require(id);
 m._compile(ts.transpileModule(fs.readFileSync(path.join(__dirname,name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,path.join(__dirname,name+'.ts'));
 return m.exports;
}
const wav=load('wav-stretch',{'./tts-gpu':load('tts-gpu')});
const {audioFileToMonoWav,audioToMonoWav}=load('audio-splice',{'./wav-stretch':wav});
function ffmpeg(args) {
 return new Promise((resolve,reject)=>{
  const p=spawn('ffmpeg',['-hide_banner','-loglevel','error',...args],{stdio:['ignore','ignore','pipe']});
  const errors=[];p.stderr.on('data',b=>errors.push(b));p.on('error',reject);
  p.on('close',code=>code===0?resolve():reject(Error(Buffer.concat(errors).toString()||`ffmpeg ${code}`)));
 });
}
test('seekable original MP3 decode removes end padding within one resampling frame; pipe does not',async()=>{
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'ff7-jp-padding-'));
 try {
  // Non-frame-aligned PCM creates real encoder padding and a seekable Xing/LAME duration tag.
  const sourceRate=32000,sourceFrames=14929;
  const samples=Float32Array.from({length:sourceFrames},(_,i)=>.4*Math.sin(2*Math.PI*440*i/sourceRate));
  const source=path.join(dir,'source.wav'),mp3=path.join(dir,'original.mp3');
  await fsp.writeFile(source,wav.encodeWavMono(sourceRate,samples));
  await ffmpeg(['-i',source,'-c:a','libmp3lame','-q:a','2',mp3]);
  const decoded=wav.decodeWavMono(await audioFileToMonoWav(mp3));
  const piped=wav.decodeWavMono(await audioToMonoWav(await fsp.readFile(mp3)));
  assert.equal(decoded.sampleRate,24000);
  const expectedFrames=sourceFrames/sourceRate*decoded.sampleRate;
  assert.ok(Math.abs(decoded.samples.length-expectedFrames)<=1,`file ${decoded.samples.length}, expected ${expectedFrames} ±1 frame`);
  assert.ok(piped.samples.length-decoded.samples.length>24,`pipe must expose >1ms padding: file=${decoded.samples.length}, pipe=${piped.samples.length}`);
  await assert.rejects(audioFileToMonoWav(path.join(dir,'missing.mp3')),/No such file|not found/);
 } finally {await fsp.rm(dir,{recursive:true,force:true});}
});
