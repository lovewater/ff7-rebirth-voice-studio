/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),{readFileSync}=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function load(reply){const calls=[];const m=new Module(__filename);m.require=id=>{if(id==='./auto-run-llm')return{parseJsonObject:JSON.parse,rewriteChat:async(...args)=>{calls.push(args);return{content:JSON.stringify({text:reply})};}};throw Error(id);};m._compile(ts.transpileModule(readFileSync(`${__dirname}/subtitle-quotes.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,`${__dirname}/subtitle-quotes.ts`);return {...m.exports,calls};}
test('Japanese corner quotes trigger cleanup; Chinese and English quotes are both accepted as already present',async()=>{
 const s=load('unused');for(const jp of ['その名も『オトリ作戦』だ！','その名も「オトリ作戦」だ！']){
 assert.equal(s.needsSubtitleQuotes(jp,'名叫诱饵作战！'),true);
 for(const cn of ['名叫“诱饵作战”！','名叫‘诱饵作战’！','名叫"诱饵作战"！',"名叫'诱饵作战'！"]){assert.equal(s.needsSubtitleQuotes(jp,cn),false);assert.equal(await s.addSubtitleQuotes(jp,cn),cn);}}
 assert.equal(await s.addSubtitleQuotes('その名もオトリ作戦だ！','名叫诱饵作战！'),'名叫诱饵作战！');assert.equal(s.calls.length,0);
});
test('3600 final caption uses exactly one independent quote-only request, preserving text and line breaks',async()=>{
 const s=load('名字嘛，就是\n“诱饵作战”！');
 assert.equal(await s.addSubtitleQuotes('その名も 『オトリ作戦』だ！','名字嘛，就是\n诱饵作战！'),'名字嘛，就是\n“诱饵作战”！');
 assert.equal(s.calls.length,1);assert.equal(s.calls[0][2],'subtitle-quotes');assert.match(s.calls[0][0][0].content,/不负责翻译、改写或断行/);
});
test('quote validation rejects word, punctuation, whitespace or line changes and malformed quote pairs',()=>{
 const {validateSubtitleQuotes}=load();const original='名字嘛，就是\n诱饵作战！';
 for(const value of ['名字嘛，就是\n“诱饵战术”！','名字嘛就是\n“诱饵作战”！','名字嘛，就是“诱饵作战”！','名字嘛，就是\n “诱饵作战”！','名字嘛，就是\n“诱饵作战！','名字嘛，就是\n“诱饵作战”！“',original,null])assert.throws(()=>validateSubtitleQuotes(original,value));
 assert.equal(validateSubtitleQuotes(original,'名字嘛，就是\n"诱饵作战"！'),'名字嘛，就是\n"诱饵作战"！');
});
function finishHarness({source='名字嘛，就是，诱饵作战！',concurrent=false}={}){
 const s=load('unused'),calls={models:0,updates:[],logs:[]};
 const sql=async(parts,...values)=>{const query=parts.join('?');
 if(query.includes('AS japanese'))return[{japanese:'その名も 『オトリ作戦』だ！',chinese:source}];
 if(query.includes('UPDATE line_tts_versions v SET subtitle_text')){calls.updates.push(values);return concurrent?[]:[{id:'1'}];}
 if(query.includes('SELECT stem FROM line_auto_runs'))return[{stem:'test'}];
 if(query.includes('AS original_subtitle'))return[{id:'1',subtitle_text:source,original_subtitle:'原来的另一句台词！'}];return[];};sql.json=x=>x;sql.begin=fn=>fn(sql);
 const m=new Module(__filename);m.require=id=>id==='./final-auto-subtitle'?require('./final-auto-subtitle.ts'):id==='./llm-metrics'?{llmMetricsForRun:()=>({tokens:null,speed:null})}:id==='./db'?{sql}:id==='./subtitle-quotes'?{needsSubtitleQuotes:s.needsSubtitleQuotes,addSubtitleQuotes:async()=>{calls.models++;return '名字嘛，就是，“诱饵作战”！';}}:{};
 m._compile(ts.transpileModule(readFileSync(`${__dirname}/auto-run.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText+'\nexports.finish=finish;exports.setup=fn=>log=fn;',`${__dirname}/auto-run.ts`);m.exports.setup(async(...args)=>calls.logs.push(args));
 return{calls,finish:()=>m.exports.finish('run','passed',null,'1')};
}
test('actual finalization adds quotes once after selection and guards against concurrent subtitle edits',async()=>{
 const s=finishHarness();await s.finish();assert.equal(s.calls.models,1);assert.equal(s.calls.updates.length,1);assert.equal(s.calls.updates[0].at(-1),'名字嘛，就是，诱饵作战！');assert.match(s.calls.logs[0][2],/正文保持不变/);
 const changed=finishHarness({concurrent:true});await changed.finish();assert.match(changed.calls.logs[0][2],/保留现有字幕/);
});
test('actual finalization with existing English quotes does not call the quote model or rewrite the subtitle',async()=>{
 const s=finishHarness({source:'名字嘛，就是，"诱饵作战"！'});await s.finish();assert.equal(s.calls.models,0);assert.equal(s.calls.updates.length,0);
});
