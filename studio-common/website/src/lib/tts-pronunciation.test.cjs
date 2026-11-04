/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS 独立脚本及测试加载器 */
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function load(file,overrides={}){
 const m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(__dirname);
 m.require=id=>id in overrides?overrides[id]:id.startsWith(".")&&fs.existsSync(require("node:path").resolve(require("node:path").dirname(file),id+".ts"))?load(require("node:path").resolve(require("node:path").dirname(file),id+".ts")):require(id);
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
 return m.exports;
}
const policy=load(`${__dirname}/tts-pronunciation.ts`),{applyTtsPronunciation:apply,ttsPronunciationBody:body}=policy;
test('了的词级读音映射保留标点边界，重复应用不变',()=>{
 const original='了解了！真了不起。受不了了[停顿=500]做个了断\n一目了然';
 const expected='LIAO3解了！真LIAO3不起。受不LIAO3了[停顿=500]做个LIAO3断\n一目LIAO3然';
 assert.equal(apply(original),expected);assert.equal(apply(expected),expected);
 assert.equal(apply('我已经LIAO3解情况了。'),'我已经LIAO3解情况了。');
 assert.equal(apply('了\n解。了[停顿=500]解。'),'了\n解。了[停顿=500]解。');
});
test('全文中发现的跨词边界反例不能替换',()=>{
 for(const s of ['为了解开这个谜','为了得到蜜娜的认可','为了得知真相','没有人赢得了解放手臂的我','经过了事无巨细的考察','经历了无数岁月','听说成了当红歌手','不能被通知了的人发现','下落不明了','你变聪明了','不了，我想克劳德比较擅长','夺得了总裁奖'])assert.equal(apply(s),s);
 assert.equal(apply('为了了解真相，身手了得的他来了'),'为了LIAO3解真相，身手LIAO3得的他来了');
});
test('只处理中文合成请求，原对象及数据库用的朗读稿保持汉字',()=>{
 const request={text:'了解了',lang:'ZH',prompt_audio:'unchanged'};
 assert.deepEqual(body('/v1/tts/clone',request),{...request,text:'LIAO3解了'});
 assert.equal(request.text,'了解了');assert.equal(body('/v1/speaker/register',request),request);
 assert.equal(body('/v1/tts',{...request,lang:'EN'}).text,'了解了');
 assert.equal(body('/v1/tts',null),null);
});
test('实际 HTTP 出站公共入口使用词库',async()=>{
 const gpu=load(`${__dirname}/tts-gpu.ts`,{'./auto-run-rules':{ALIGN_SILENCE_RATIO:.05},'./tts-pronunciation-db':{prepareTtsPronunciationBody:async (...args)=>policy.ttsPronunciationBody(...args)}});
 const old=global.fetch,requests=[];
 global.fetch=async(url,init)=>{requests.push(JSON.parse(init.body));return {ok:true,json:async()=>({ok:true})};};
 try {
  for(const endpoint of ['/v1/tts','/v1/tts/clone'])await gpu.gpuJsonAt('http://test.invalid',endpoint,{text:'我了解了',lang:'ZH'});
  await gpu.gpuJsonAt('http://test.invalid','/v1/speaker/register',{text:'了解'});
  assert.deepEqual(requests.map(r=>r.text),['我LIAO3解了','我LIAO3解了','了解']);
 } finally {global.fetch=old;}
});

test('数据库拼音分类只在中文合成出站查询，按数据库内容转换而非静态种子',async()=>{
 const queries=[];
 const sql=async(parts)=>{queries.push(parts.join(''));return [{src:'了解',dst:'TEST3解'}];};
 const db=load(`${__dirname}/tts-pronunciation-db.ts`,{'./db':{sql},'./tts-pronunciation':policy});
 assert.equal((await db.prepareTtsPronunciationBody('/v1/tts',{text:'了解了',lang:'ZH'})).text,'TEST3解了');
 assert.match(queries[0],/WHERE usage = 'tts_pinyin'/);
 assert.equal((await db.prepareTtsPronunciationBody('/v1/tts',{text:'了不起'})).text,'了不起');
 await db.prepareTtsPronunciationBody('/health',{});
 await db.prepareTtsPronunciationBody('/v1/tts',{text:'了解',lang:'EN'});
 assert.equal(queries.length,2);
});
test('只读拼音词库在 API 层拒绝新增、修改和删除',async()=>{
 const responses={json:(body,options={})=>({body,status:options.status??200})};
 const next={'next/server':{NextResponse:responses}};
 const queries=[];
 const sql=async(parts)=>{queries.push(parts.join(''));return [{usage:'tts_pinyin'}];};
 const root=`${__dirname}/../app/api/pronunciations`;
 const item=load(root+'/[id]/route.ts',{...next,'@/lib/db':{sql}});
 const request={json:async()=>({src:'了解',dst:'XX',usage:'tts_pinyin'})},ctx={params:Promise.resolve({id:'1'})};
 assert.equal((await item.PATCH(request,ctx)).status,403);
 assert.equal((await item.DELETE(request,ctx)).status,403);
 assert.ok(queries.every(q=>q.startsWith('SELECT')));
 const collection=load(root+'/route.ts',{...next,'@/lib/db':{sql}});
 assert.equal((await collection.POST(request)).status,403);
});
