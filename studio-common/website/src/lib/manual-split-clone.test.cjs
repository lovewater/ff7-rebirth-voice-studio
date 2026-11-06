/* eslint-disable @typescript-eslint/no-require-imports */
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),Module=require('node:module'),ts=require('typescript');
const cwd=process.cwd(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'manual-split-'));after(()=>{process.chdir(cwd);fs.rmSync(temp,{recursive:true,force:true});});
let run,events,snapshot=[];const cache=new Map();
const sql=async(parts)=>{const q=parts.join('');if(q.includes('FROM line_auto_runs'))return run?[run]:[];if(q.includes('FROM line_auto_run_events'))return events;if(q.includes('FROM line_tts_versions'))return snapshot;throw Error('unexpected SQL '+q);};
function load(file){file=path.resolve(__dirname,file);if(cache.has(file))return cache.get(file).exports;const m=new Module(file,module);cache.set(file,m);m.paths=module.paths;m.require=id=>id==='./db'?{sql}:id.startsWith('.')&&fs.existsSync(path.resolve(path.dirname(file),id)+'.ts')?load(path.relative(__dirname,path.resolve(path.dirname(file),id)+'.ts')):require(id);m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);return m.exports;}
const lib=load('manual-split-clone.ts'),{buildSpeechReference}=load('tts-reference.ts'),{parseWavPcm16}=load('tts-gpu.ts'),{extractCasualBodyReference}=load('casual-audio-cleanup.ts');
const {audioToMonoWav}=load('audio-splice.ts');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function wave(seconds=2,edges=true){const frames=Math.round(seconds*24000),b=Buffer.alloc(44+frames*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(frames*2,40);for(let i=0;i<frames;i++)if(!edges||i<9600||(i>=14400&&i<40800))b.writeInt16LE(2000,44+i*2);return b;}
async function setup({empty=false,unknown=false,whole=false,casual=false}={}){
 process.chdir(temp);fs.mkdirSync('data/jp',{recursive:true});fs.mkdirSync('data/tts/a',{recursive:true});snapshot=[];
 const source=wave(2,!whole),original=casual?source:await audioToMonoWav(source);fs.writeFileSync('data/jp/a.mp3',source);
 const speech=whole?[{startMs:0,endMs:2000}]:[{startMs:600,endMs:1700}];
 const ono=whole?[]:[{startMs:0,endMs:400}];
 let reference=buildSpeechReference(original,parseWavPcm16(original),{speech,onomatopoeia:ono,ambient:[]}).audio;
 const promptPath='tts/a/auto-run-2-prompt.wav';run=empty?null:{id:'2',status:'passed',reference_audio_path:promptPath,reference_text_jp:'こんにちは'};
 const line={stem:'a',text_jp:'こんにちは',text_zh:'嗯，你好'};
 events=[{step:'reference',payload:{stage:1,promptPath}},{step:'ono',payload:{stage:1,enabled:!whole,speech,onomatopoeia:ono,ambient:[],cnTtsText:'你好'}},{step:'segment',payload:{stage:1,segments:[...speech.map(x=>({...x,kind:'speech'})),...(unknown?[{kind:'unknown'}]:[])]}},{step:'subtitle-plan',payload:{stage:1,sourceScript:line.text_zh}}];
 if(casual){const plan={version:1,enabled:true,reason:'test',originalTextZh:'嗯，你好',bodyTextZh:'你好',bodyTextJp:'こんにちは',bodyStartFrame:14400,bodyEndFrame:40800,sourceFrames:48000,sampleRate:24000,sourcePcmSha256:hash(original.subarray(44)),preserved:[{side:'head',startFrame:0,endFrame:14400,kind:'nonverbal'},{side:'tail',startFrame:40800,endFrame:48000,kind:'unclassified'}],removedChinesePrefix:'嗯，',removedChineseSuffix:'',evidence:{}};reference=extractCasualBodyReference(original,plan);events=[{step:'casual-clean-reference',payload:{stage:1,promptPath,plan,sha256:hash(reference)}}];}
 fs.writeFileSync('data/'+promptPath,reference);return {line,original,reference};
}
test('unprocessed, running, wrong run, no removed sound, or unknown segments hide split cloning',async()=>{
 let f=await setup({empty:true});assert.equal(await lib.loadSplitClone(f.line),null);
 f=await setup();run.status='running';assert.equal(await lib.loadSplitClone(f.line),null);
 f=await setup();assert.equal(await lib.loadSplitClone(f.line,'1'),null);
 f=await setup({whole:true});assert.equal(await lib.loadSplitClone(f.line),null);
 f=await setup({unknown:true});assert.equal(await lib.loadSplitClone(f.line),null);
});
test('confirmed scene cut reuses the exact cleaned reference and the user body draft',async()=>{
 const f=await setup(),context=await lib.loadSplitClone(f.line,'2');assert.ok(context);assert.equal(context.kind,'scene');assert.ok(context.reference.equals(f.reference));assert.ok(context.removedSeconds>0);
 assert.equal(lib.splitCloneBodyText(context,'嗯，你好'),'你好');assert.equal(lib.splitCloneBodyText(context,'再见'),'再见');assert.equal(lib.splitCloneBodyText(context,'嗯，再见'),'再见');
 const mixed=await lib.assembleSplitClone(context,wave(.9,false),'你好');assert.ok(Math.abs(parseWavPcm16(mixed.audio).frames/24000-2)<.001);assert.equal(mixed.restoredText,'嗯，你好');
 assert.equal(mixed.metadata.fit.scales['ono-0'],1);for(let i=0;i<9600;i++)assert.ok(Math.abs(mixed.audio.readInt16LE(44+i*2)-f.original.readInt16LE(44+i*2))<=3);
 await assert.rejects(()=>lib.assembleSplitClone(context,wave(3,false),'你好'),/总长|装入|时长/);
});
test('changed source, changed reference, changed original text or unsafe path cannot reuse AI cuts',async()=>{
 let f=await setup();const altered=Buffer.from(f.reference);altered.writeInt16LE(8000,44);fs.writeFileSync('data/tts/a/auto-run-2-prompt.wav',altered);assert.equal(await lib.loadSplitClone(f.line),null);
 f=await setup();snapshot=[{jp_text_snapshot:'改过原文',game_zh_text_snapshot:f.line.text_zh}];assert.equal(await lib.loadSplitClone(f.line),null);
 f=await setup();f.line.extra={audio_sources:{jp:{clip:{mp3_sha256:'0'.repeat(64)}}}};assert.equal(await lib.loadSplitClone(f.line),null);
 f=await setup();run.reference_audio_path='tts/a/../b.wav';assert.equal(await lib.loadSplitClone(f.line),null);
});
test('ordinary AI edge cleanup restores original PCM head and tail without new classification',async()=>{
 const f=await setup({casual:true}),context=await lib.loadSplitClone(f.line);assert.equal(context.kind,'casual');
 const mixed=await lib.assembleSplitClone(context,wave(.8,false),'你好');assert.equal(mixed.metadata.pcmExact,true);assert.equal(mixed.restoredText,'嗯，你好');
 assert.ok(mixed.audio.subarray(44,44+14400*2).equals(f.original.subarray(44,44+14400*2)));
 const tail=f.original.subarray(44+40800*2);assert.ok(mixed.audio.subarray(-tail.length).equals(tail));
});
