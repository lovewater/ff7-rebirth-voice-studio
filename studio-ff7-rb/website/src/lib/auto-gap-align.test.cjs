/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const cache=new Map();function load(file){if(cache.has(file))return cache.get(file).exports;const m=new Module(file);cache.set(file,m);m.require=id=>id.startsWith('./')?load(path.resolve(path.dirname(file),id+'.ts')):require(id);m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);return m.exports;}
const {autoGapAlign:align}=load(__dirname+'/auto-gap-align.ts'),{encodeWavMono:encode,decodeWavMono:decode}=load(__dirname+'/wav-stretch.ts');
function wav(parts,sr=1000){const a=[];for(const [s,voiced]of parts)for(let i=0;i<Math.round(s*sr);i++)a.push(voiced?(i%2?-.31:.49):0);return encode(sr,Float32Array.from(a));}
test('a short candidate caused by a missing pause is fixed without adding words or stretching PCM',()=>{
 const ref=wav([[.1,0],[.4,1],[1,0],[.6,1],[.2,0]]),cn=wav([[.2,0],[.4,1],[.3,0],[.6,1],[.1,0]]),before=Buffer.from(cn),result=align(cn,ref);
 assert.ok(result);assert.equal(result.meta.speechStretch,1);assert.equal(result.meta.gapSeconds,1);assert.equal(result.meta.afterSeconds,2.3);
 assert.deepEqual(result.audio.subarray(44+100*2,44+500*2),cn.subarray(44+200*2,44+600*2));
 assert.deepEqual(result.audio.subarray(44+1500*2,44+2100*2),cn.subarray(44+900*2,44+1500*2));assert.deepEqual(cn,before);
});
test('no automatic silence guessing for one voice block, multiple pauses, or impossible negative middle gap',()=>{
 const ref=wav([[.4,1],[.3,0],[.4,1]]);
 for(const cn of [wav([[1,1]]),wav([[.4,1],[.3,0],[.4,1],[.3,0],[.4,1]]),wav([[1,1],[.3,0],[1,1]])])assert.equal(align(cn,ref),null);
});
test('cleaned Japanese references and differing sample rates keep reference edge limits and duration',()=>{
 const ref=wav([[.01,0],[.4,1],[.7,0],[.5,1],[.02,0]],2000),cn=wav([[.3,0],[.3,1],[.3,0],[.4,1],[.4,0]],1000),result=align(cn,ref);
 assert.ok(result);assert.equal(result.meta.leadingSeconds,.01);assert.equal(result.meta.trailingSeconds,.02);assert.equal(decode(result.audio).samples.length,1630);
});
