/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const calls=[];let reply={kind:'onomatopoeia',reason:'唔嗝是打嗝的拟声表达'};
const m=new Module(__filename);m.require=id=>id==='./auto-run-llm'?{parseJsonObject:JSON.parse,rewriteChat:async(...args)=>{calls.push(args);return{content:JSON.stringify(reply)}}}:require(id);
m._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/missing-jp-subtitle.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,`${__dirname}/missing-jp-subtitle.ts`);
const {classifyMissingJapaneseSubtitle:classify,missingJapaneseSubtitleMessages:messages}=m.exports;
test('missing-Japanese prompt requires full Chinese FX and no explicit Japanese speech evidence',async()=>{
 const [system,user]=messages('唔嗝！','行こう。');assert.match(system.content,/整句/);assert.match(system.content,/不能仅因中文是拟声就断言日文ASR错了/);assert.match(system.content,/你没有听到音频/);assert.match(system.content,/行こう/);
 const input=JSON.parse(user.content);assert.equal(input.chinese_subtitle,'唔嗝！');assert.equal(input.japanese_text_from_seed_asr,'行こう。');
 reply={kind:'speech',reason:'行こう是走吧，日文有正文'};assert.equal((await classify('唔嗝！','行こう。')).kind,'speech');assert.equal(calls.length,1);assert.equal(calls[0][2],'missing-jp-subtitle-classification');assert.equal(calls[0][3],1);
 reply={kind:'onomatopoeia',reason:'空ASR且中文全拟声'};assert.equal((await classify('唔嗝！','')).kind,'onomatopoeia');
});
test('only validated enum is accepted, and empty Chinese cannot become confirmed reaction',async()=>{
 reply={kind:'onomatopoeia',reason:'误判'};await assert.rejects(()=>classify('',''),/空中文字幕/);
 reply={kind:'speech',reason:'有实际正文'};assert.equal((await classify('唔嗝，我吃饱了！','')).kind,'speech');
 reply={kind:'unknown',reason:'不能确认'};assert.equal((await classify('这','')).kind,'unknown');
 for(const invalid of [{kind:true,reason:'无效'},{kind:'onomatopoeia'},{kind:'other',reason:'无效'}]){reply=invalid;await assert.rejects(()=>classify('唔嗝！',''),/格式无效/);}
});
