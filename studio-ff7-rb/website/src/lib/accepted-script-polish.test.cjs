/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
function setup(responses){const cache=new Map(),calls=[];function load(file){if(cache.has(file))return cache.get(file).exports;const m=new Module(file);cache.set(file,m);m.require=id=>{
 if(id==='./llm-chat-client')return{callChatCompletion:async input=>{calls.push(structuredClone(input));const value=responses.shift();if(value instanceof Error)throw value;return{content:typeof value==='string'?value:JSON.stringify(value)};}};
 return id.startsWith('./')?load(path.resolve(path.dirname(file),id+'.ts')):require(id);
 };m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return m.exports;}return{...load(__dirname+'/accepted-script-polish.ts'),calls};}
const parts=['算是达到合格线了','身为塔克斯','无论何时都要全力以赴别忘了'];
const args={stem:'test',script:parts.join('，'),requiredParts:3,policy:'strict',textJp:'固定日文',textZh:'固定中文字幕',textEn:'original'};
test('natural word-order edit preserves each segment and accepts only validated equal counts',async()=>{const c=setup([{parts:[...parts.slice(0,2),'别忘了无论何时都要全力以赴'],reason:'段内移词'}]);const r=await c.polishAcceptedScript(args);assert.equal(r.changed,true);assert.equal(r.script,'算是达到合格线了\n身为塔克斯\n别忘了无论何时都要全力以赴');assert.equal(c.calls.length,1);assert.equal(c.calls[0].task,'accepted-script-polish');assert.match(c.calls[0].messages[1].content,/固定中文字幕/);});
test('real observed fourteen-versus-thirteen failure is rejected and fed back once',async()=>{const c=setup([{parts:[...parts.slice(0,2),'无论何时都须全力以赴不可忘记']},{parts:[...parts.slice(0,2),'别忘了无论何时都要全力以赴']}]);const r=await c.polishAcceptedScript(args);assert.equal(r.changed,true);assert.equal(r.attempts,2);assert.match(c.calls[1].messages.at(-1).content,/13个汉字.*14个汉字/);});
test('two invalid model responses retain the accepted original and stop',async()=>{const c=setup([{parts:['改坏的稿']},'bad json']);const r=await c.polishAcceptedScript(args);assert.equal(r.changed,false);assert.equal(r.script,args.script);assert.equal(c.calls.length,2);});
test('unchanged response avoids extra TTS; ambiguous relaxed boundaries avoid a model request',async()=>{const c=setup([{parts}]);assert.equal((await c.polishAcceptedScript(args)).changed,false);assert.equal((await c.polishAcceptedScript({...args,policy:'relaxed'})).attempts,0);assert.equal(c.calls.length,1);});
test('equal total counts cannot compensate for moving text between segments',()=>{const c=setup([]);assert.equal(c.validatePolishParts(['甲乙','丙丁'],['甲','乙丙丁']).pass,false);assert.equal(c.validatePolishParts(['甲乙'],['甲乙A']).pass,false);assert.equal(c.validatePolishParts(['甲乙'],['甲[停顿=500]乙']).pass,false);});
test('lines retain semantic boundaries and one-line performance can also be polished',async()=>{const c=setup([{parts:['乙甲','丁丙']},{parts:['乙甲']}]);const multi=await c.polishAcceptedScript({...args,script:'甲乙\n丙丁',requiredParts:2,policy:'lines'});assert.equal(multi.script,'乙甲\n丁丙');const single=await c.polishAcceptedScript({...args,script:'甲乙',requiredParts:1});assert.equal(single.script,'乙甲');});

function fallbackRoute(available){const events=[],finished=[];const file=__dirname+'/auto-run.ts',m=new Module(file);const sql=async()=>available?[{id:'old-accepted'}]:[];
 m.require=id=>id.startsWith('node:')?require(id):id==='./db'?{sql}:id==='./auto-run-fallback'?{closestFallback:()=>null}:{};
 const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 m._compile(source+'\nexports.setup=()=>{log=async(...args)=>events.push(args);finish=async(...args)=>finished.push(args);};exports.testFallback=finishWithFallback;'.replace('events.push(args)','globalThis.__polishEvents.push(args)').replace('finished.push(args)','globalThis.__polishFinished.push(args)'),file);
 globalThis.__polishEvents=events;globalThis.__polishFinished=finished;m.exports.setup();return{events,finished,run:()=>m.exports.testFallback('run',{candidates:[],acceptedFinalId:'old-accepted'},'润色合成或核字失败')};}
test('polish service, timing or assembly failure preserves the previously accepted final as passed',async()=>{const c=fallbackRoute(true);await c.run();assert.deepEqual(c.finished[0],['run','passed',null,'old-accepted']);assert.equal(c.events[0][1],'polish-fallback');});
test('manual abnormal marking of old accepted audio prevents automatic polish fallback to it',async()=>{const c=fallbackRoute(false);await c.run();assert.equal(c.finished[0][1],'failed');assert.equal(c.finished[0][3],null);});

test('polish retains punctuation inside semantic parts and treats the ten-character reminder as soft',async()=>{const c=setup([{parts:['算是达到合格线了','身为塔克斯','别忘了，无论何时都要全力以赴']}]);const r=await c.polishAcceptedScript(args);assert.equal(r.changed,true);assert.equal(r.policy,'lines');assert.match(r.script,/别忘了，/);assert.match(c.calls[0].messages[0].content,/连续10个或更多汉字/);assert.match(c.calls[0].messages[0].content,/不是硬性合格条件/);assert.equal(c.validatePolishParts(parts,parts).pass,true);});
test('双语断句润色可仅移动片内停顿，保留正文和原有硬约束，不虚构英文时轴',async()=>{
 const c=setup([{parts:['我们是不是……上下颠倒了？'],reason:'先带出疑问再停顿'}]);
 const r=await c.polishAcceptedScript({...args,script:'我们……是不是上下颠倒了？',requiredParts:1,textJp:'わたしたち 逆さま？',textEn:'We just get turned upside down!?'});
 assert.equal(r.changed,true);assert.equal(r.script,'我们是不是……上下颠倒了？');
 const prompt=c.calls[0].messages[0].content;
 assert.match(prompt,/同时参考日文和英文/);assert.match(prompt,/不能直接当成实际停顿/);
 assert.match(prompt,/不得编造数值/);assert.match(prompt,/不强求各段等长或字数均分/);
 assert.match(prompt,/正文字符和顺序不变/);assert.match(prompt,/不跨段移动文字/);
 assert.equal(c.validatePolishParts(['我们','是不是上下颠倒了'],['我们是不是','上下颠倒了']).pass,false);
});
