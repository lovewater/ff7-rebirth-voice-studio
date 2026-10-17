/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function load(name){const m=new Module(__filename);m.require=id=>id.startsWith('./')?load(id.slice(2)):require(id);m._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/${name}.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,`${__dirname}/${name}.ts`);return m.exports;}
const {quickTimingPass,parseQuickPick,quickPickMessages}=load('auto-run-quick');
const timing={start:.1,end:3.1,dur:3.3,speech:3};
const candidate=(ttsId,asr='完整台词')=>({ttsId,asr,spoken:'完整台词',timing,score:0});
const review=(ttsId,extra={})=>({ttsId,pass:true,missing:[],extra:[],repeated:[],unrelated:[],pronunciationNotes:[],reason:'完整',...extra});
test('quick timing requires full alignment and actual speech, not padded total duration alone',()=>{
 assert.equal(quickTimingPass(timing,timing,false),true);
 for(const changed of [{start:.3},{end:2.6},{dur:3.8},{speech:2.4},{speech:0},{end:null},{start:NaN}])assert.equal(quickTimingPass(timing,{...timing,...changed},false),false);
 assert.equal(quickTimingPass({...timing,speech:null},timing,false),false);
 assert.equal(quickTimingPass({start:null,end:null,dur:null,speech:null},timing,true),true);
});
test('missing short word cannot win ranking; least pronunciation issues precede model preference',()=>{
 const result=parseQuickPick({reviews:[review('1',{missing:['缺少就']}),review('2',{pronunciationNotes:['近音']}),review('3')],ranking:['1','2','3']},[candidate('1'),candidate('2'),candidate('3')]);
 assert.equal(result.selected,'3');assert.equal(result.reviews[0].ok,false);
});
test('all hard failures and empty ASR return no winner instead of weakening quality',()=>{
 const result=parseQuickPick({reviews:[review('1',{missing:['漏句']}),review('2')],ranking:['1','2']},[candidate('1'),candidate('2','')]);
 assert.equal(result.selected,null);
});
test('one passing candidate is selectable, ties follow model order',()=>{
 assert.equal(parseQuickPick({reviews:[review('1')],ranking:['1']},[candidate('1')]).selected,'1');
 assert.equal(parseQuickPick({reviews:[review('1'),review('2')],ranking:['2','1']},[candidate('1'),candidate('2')]).selected,'2');
});
test('missing, repeated, foreign review or ranking ids fail closed',()=>{
 const cs=[candidate('1'),candidate('2')];
 for(const output of [{reviews:[review('1')],ranking:['1','2']},{reviews:[review('1'),review('1')],ranking:['1','2']},{reviews:[review('1'),review('9')],ranking:['1','2']},{reviews:[review('1'),review('2')],ranking:['1','1']},{reviews:[review('1'),review('2')],ranking:['1','9']}])assert.throws(()=>parseQuickPick(output,cs));
});
test('quick prompt library reproduces bound system/input with documented JSON placeholders',()=>{
 const defs=require('./prompt-seed.test.json'),{renderPrompt}=load('prompt-template');
 const messages=quickPickMessages({original:'原字幕',textJp:'日本語',textEn:'English',lexicon:[],candidates:[candidate('1')]});
 for(const m of messages){const def=defs.find(d=>d.key===m.promptKey);assert.ok(def);assert.equal(renderPrompt(def.prompt,m.promptValues),m.content);}
});
