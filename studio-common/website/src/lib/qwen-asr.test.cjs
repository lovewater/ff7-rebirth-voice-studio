/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const m=new Module(__filename);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/qwen-asr.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);const {qwenAsr}=m.exports;
async function mocked(payload,run){const old=global.fetch,calls=[];global.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>payload};};try{return await run(calls);}finally{global.fetch=old;}}
const axis={model:'Qwen/Qwen3-ForcedAligner-0.6B',status:'ok',time_unit:'seconds',items:[{text:'待って',start_time:.2,end_time:.4}]};
test('default and explicit false preserve existing request/return contract',async()=>{
 await mocked({success:true,results:[{text:'你好',language:'Chinese',alignment:axis}]},async calls=>{
  for(const options of [undefined,{useForcedAligner:false}]){const r=await qwenAsr('base64','Chinese',options);assert.equal(r.text,'你好');assert.equal(Object.hasOwn(r,'alignment'),false);}
  assert.ok(calls.every(c=>!Object.hasOwn(c.body,'use_forced_aligner')));
 });
});
test('explicit opt-in sends flag and returns seconds axis without flattening zero-width units',async()=>{
 const value={...axis,items:[...axis.items,{text:'て',start_time:.4,end_time:.4}]};
 await mocked({success:true,results:[{text:'待って',language:'Japanese',alignment:value}]},async calls=>{const r=await qwenAsr('base64','Japanese',{useForcedAligner:true});assert.equal(calls[0].body.use_forced_aligner,true);assert.deepEqual(r.alignment,value);assert.equal(r.raw.results[0].alignment,value);});
});
test('multiple ASR results retain legacy text aggregation but cannot mix first axis with aggregate',async()=>{
 await mocked({success:true,results:[{text:'一',language:'Japanese',alignment:axis},{text:'二',language:'Japanese',alignment:axis}]},async()=>{const r=await qwenAsr('base64','Japanese',{useForcedAligner:true});assert.equal(r.text,'一二');assert.equal(r.alignment.status,'error');assert.deepEqual(r.alignment.items,[]);});
});
test('missing or malformed alignment retains transcript and reports unusable evidence',async()=>{
 for(const bad of [undefined,{...axis,time_unit:'milliseconds'},{...axis,items:[{text:'待って',start_time:'0.2',end_time:.4}]},{...axis,items:[{text:'待って',start_time:NaN,end_time:.4}]}])await mocked({success:true,results:[{text:'待って',language:'Japanese',alignment:bad}]},async()=>{const r=await qwenAsr('base64','Japanese',{useForcedAligner:true});assert.equal(r.text,'待って');assert.equal(r.alignment.status,'error');});
});
test('alignment error/empty statuses are retained rather than pretending to return an axis',async()=>{
 for(const status of ['error','empty','unsupported_language'])await mocked({success:true,results:[{text:'待って',language:'Japanese',alignment:{...axis,status,items:[],error:'reason'}}]},async()=>{const r=await qwenAsr('base64','Japanese',{useForcedAligner:true});assert.equal(r.alignment.status,status);assert.equal(r.alignment.error,'reason');});
});
