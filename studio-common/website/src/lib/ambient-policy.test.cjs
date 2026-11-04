/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const cache=new Map();function load(file){if(file.endsWith('.json.ts'))return require(file.slice(0,-3));if(file.endsWith('/db.ts'))return {sql:()=>{throw Error('禁止数据库调用')}};if(cache.has(file))return cache.get(file).exports;const m=new Module(file);cache.set(file,m);m.require=id=>id.startsWith('./')?load(path.resolve(path.dirname(file),id+'.ts')):require(id);m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);return m.exports;}
const {applyAmbientPolicy}=load(__dirname+'/ambient-policy.ts');
const {encodeWavMono,decodeWavMono}=load(__dirname+'/wav-stretch.ts');
const {buildSpeechReference}=load(__dirname+'/tts-reference.ts'),{parseWavPcm16}=load(__dirname+'/tts-gpu.ts');
test('450ms包含边界，只忽略已确认环境音，不忽略短情绪拟声或更长环境音',()=>{
 const ambient=[{startMs:0,endMs:390},{startMs:1000,endMs:1450},{startMs:2000,endMs:2450.001}];
 const original={enabled:true,ambient,onomatopoeia:[{startMs:3000,endMs:3020}],speech:[]};
 const result=applyAmbientPolicy(original);
 assert.deepEqual(result.ambient,[ambient[2]]);assert.deepEqual(result.ignoredAmbient,ambient.slice(0,2));
 assert.deepEqual(result.onomatopoeia,original.onomatopoeia);assert.equal(original.ambient.length,3);
 assert.deepEqual(applyAmbientPolicy(result),result);
 const shortOnly=applyAmbientPolicy({...original,onomatopoeia:[],ambient:ambient.slice(0,1)});
 assert.equal(shortOnly.enabled,false);assert.deepEqual(shortOnly.ambient,[]);
});
test('忽略390ms环境音分类后，整句原音进入克隆参考，不删除、不静音、不单独拼回',()=>{
 const audio=encodeWavMono(1000,new Float32Array(1000).fill(.4)),before=Buffer.from(audio);
 const plan=applyAmbientPolicy({enabled:true,ambient:[{startMs:0,endMs:390}],onomatopoeia:[],speech:[{startMs:390,endMs:1000}]});
 const pcm=parseWavPcm16(audio);
 assert.equal(plan.enabled,false);assert.deepEqual(plan.ambient,[]);
 const ref=buildSpeechReference(audio,pcm,plan);
 assert.equal(ref.outputFrames,1000);assert.equal(ref.removedFrames,0);
 assert.deepEqual(ref.audio,audio);assert.deepEqual(audio,before);
 assert.ok(decodeWavMono(ref.audio).samples.subarray(0,390).every(x=>x>0));
});
