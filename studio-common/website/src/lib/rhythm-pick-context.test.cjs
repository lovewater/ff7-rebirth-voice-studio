/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const speed=load('selection-speed.ts',{'./normal-speed-beat':require('./normal-speed-beat.ts')});
const {rhythmPickMessages,RHYTHM_PICK_SYSTEM}=load('rhythm-pick-context.ts',{'./rewrite-context':require('./rewrite-context.ts'),'./selection-speed':speed});
const asr={text:'识别结果',raw:{provider:'qwen-local',waveform:{startMs:0,endMs:1000}}};
const input=()=>({textJp:'できる',jp:asr,context:{speaker:'克劳德',originalChinese:'做得到',before:[{speaker:'蒂法',textZh:'你行吗？',lockedZh:'你做得到吗？',textJp:'できる？',textEn:'Can you?'}],after:[{speaker:'蒂法',textZh:'那就交给你了',textJp:'頼む',textEn:'Please'}]},candidates:[{ttsId:'1',spoken:'能',asr,paceRatio:1},{ttsId:'2',spoken:'做得到',asr,paceRatio:1.02}]});
function load(file,overrides,append=''){
 const m=new Module(__filename);m.require=id=>overrides[id]??(id.startsWith('node:')?require(id):{});
 m.require=((resolve)=>id=>id==='./auto-run-stage-context'?require('./auto-run-stage-context.ts'):resolve(id))(m.require);m._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/${file}`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText+append,`${__dirname}/${file}`);return m.exports;
}
test('择优输入传入前后文、锁定邻句与原始本句，保留原始邻句核对',()=>{
 const data=input(),messages=rhythmPickMessages(data),payload=JSON.parse(messages[1].promptValues.input_json);
 assert.equal(payload.context.before[0].textZh,'你做得到吗？');assert.equal(payload.context.before[0].originalTextZh,'你行吗？');
 assert.equal(payload.context.after[0].textZh,'那就交给你了');assert.equal(payload.context.originalChinese,'做得到');
 assert.equal(payload.context.before[0].textJp,'できる？');assert.deepEqual(payload.candidates.map(x=>x.ttsId),['1','2']);
 assert.equal(messages[1].content,messages[1].promptValues.input_json);assert.equal(data.context.before[0].textZh,'你行吗？');
 assert.match(messages[0].content,/上下文连贯性/);assert.match(messages[0].content,/不能.*放宽读音、时长、分段/);assert.match(messages[0].content,/不编造中文字轴或声学听感/);
});
test('缺少上下文不捏造邻句，快照与运行时提示词一致',()=>{
 const data=input();delete data.context;assert.equal(JSON.parse(rhythmPickMessages(data)[1].content).context,null);
 const seed=JSON.parse(fs.readFileSync(`${__dirname}/prompt-seed.test.json`));assert.equal(seed.find(x=>x.key==='rhythm-pick.system').prompt,RHYTHM_PICK_SYSTEM);
});
test('实际pickRhythm发出上下文，模型不能选回候选池以外的音频',async()=>{
 let captured,answer='2';
 const api=load('auto-run-llm.ts',{'./rhythm-pick-context':{rhythmPickMessages},'./auto-run-two-parts':{performanceRewriteMessages:m=>m},'./rewrite-translation-reference':{withTranslationReferences:async m=>m},'./rewrite-number-hint':{withRewriteNumberHint:m=>m},'./llm-metrics':{currentLlmStem:()=>''},'./prompt-store':{resolvePromptMessages:async m=>m},'./llm-chat-client':{callChatCompletion:async args=>{captured=args;return {content:JSON.stringify({ttsId:answer,reason:'接话自然，节奏合格'}),thinking:''}}}});
 assert.equal((await api.pickRhythm(input())).ttsId,'2');assert.equal(captured.task,'rhythm-pick');assert.equal(JSON.parse(captured.messages[1].content).context.before[0].textZh,'你做得到吗？');
 answer='999';assert.equal((await api.pickRhythm(input())).ttsId,'1');
});
test('最终择优重新读上下文，单候选保持直接选用',async()=>{
 let queried=0,picked=0;const records=[];
 const row=id=>({clip:{id,spoken_text:id},asr,paceRatio:1,pronunciationNotes:[],netRate:6,netSpeechSeconds:1,spokenSyllables:6,normalizedBeatRatio:.8,beatBand:{low:.85,high:1.15},beatExempt:true,beatExemption:'normal-cn-net-speed'});
 const llm={};
 const api=load('auto-run.ts',{'./auto-run-two-parts':{rankByRhythm:rows=>({items:rows,metrics:{}})},'./spoken-text-review':{fewestPronunciationIssues:rows=>rows},'./auto-run-llm':llm},'\nexports.testPick=pickPassedClip;exports.setup=hooks=>{log=async(...args)=>hooks.logs.push(args);loadDialogueContext=hooks.context;require("./auto-run-llm").pickRhythm=hooks.pick;};');
 api.setup({logs:records,context:async()=>{queried++;return {before:input().context.before,after:[],line:{}}},pick:async data=>{picked++;assert.equal(data.context.originalChinese,'原始本句');assert.equal(data.context.speaker,'克劳德');assert.equal(data.candidates[0].netRate,6);assert.equal(data.candidates[0].normalizedBeatRatio,.8);assert.equal(data.candidates[0].beatExempt,true);return {ttsId:'2',reason:'接话自然'}}});
 const line={stem:'current',speaker:'克劳德',text_jp:'今',text_zh:'原始本句'};
 assert.equal((await api.testPick('run',line,asr,[row('1'),row('2')])).clip.id,'2');assert.equal(queried,1);assert.equal(picked,1);
 assert.ok(records.some(x=>x[1]==='pick-context'));
 assert.equal((await api.testPick('run',line,asr,[row('1')])).clip.id,'1');assert.equal(queried,1);assert.equal(picked,1);
});

test('数据库模板解析后实际请求仍包含连贯性规则和锁定邻句',async()=>{
 const defs=JSON.parse(fs.readFileSync(`${__dirname}/prompt-seed.test.json`));
 const {renderPrompt}=require('./prompt-template.ts');
 const store=load('prompt-store.ts',{'./db':{sql:async()=>defs},'./prompt-template':{renderPrompt}});
 const resolved=await store.resolvePromptMessages(rhythmPickMessages(input()));
 assert.match(resolved[0].content,/上下文连贯性/);assert.match(resolved[0].content,/不为几毫秒优势牺牲接话自然度/);
 assert.equal(JSON.parse(resolved[1].content).context.before[0].textZh,'你做得到吗？');
 assert.deepEqual(Object.keys(resolved[1]).sort(),['content','role']);
});
test('最终择优提示同时解释跨度、净语速和归一比，实际候选携带综合语速及豁免',()=>{
 const data=input();Object.assign(data.candidates[0],{netRate:6,netSpeechSeconds:.5,spokenSyllables:3,normalizedBeatRatio:.7,beatBand:{low:.85,high:1.15},beatExempt:true,beatExemption:'normal-cn-net-speed'});
 const messages=rhythmPickMessages(data),row=JSON.parse(messages[1].content).candidates[0];
 assert.equal(row.speedDescription,'速度有些稍快');assert.equal(row.netSpeech.rate,6);assert.equal(row.beat.normalizedRatio,.7);assert.equal(row.beat.exempt,true);assert.equal(row.beat.exemption,'normal-cn-net-speed');
 assert.match(messages[0].content,/paceRatio=中文朗读跨度÷日文参考朗读跨度/);assert.match(messages[0].content,/不是音节\/秒/);assert.match(messages[0].content,/÷1\.20/);assert.match(messages[0].content,/不代表净语速或拍数比都处在正常区间/);
 assert.equal(data.candidates[0].netRate,6);
});

test('post-accepted final pool reaches the model intact and the model may prefer the original despite a worse ratio',async()=>{
 const asr={text:'合格中文',raw:{text:'合格中文'}};let received;
 const api=load('auto-run.ts',{'./auto-run-two-parts':{rankByRhythm:()=>{throw Error('不能先按毫秒淘汰');}},'./spoken-text-review':{fewestPronunciationIssues:()=>{throw Error('本节点统一评选');}},'./auto-run-llm':{}},'\nexports.testPick=pickPassedClip;exports.setup=()=>{log=async()=>{};loadDialogueContext=async()=>({before:[],after:[]});require("./auto-run-llm").pickRhythm=async input=>{globalThis.__qualifiedPoolInput=input;return{ttsId:"original",reason:"原稿表达更自然"};};};');
 api.setup();
 const rows=[{clip:{id:'original',spoken_text:'原稿'},asr,paceRatio:1,pronunciationNotes:['一个可容忍疑点'],normalizedBeatRatio:1.358},{clip:{id:'optimized',spoken_text:'新稿'},asr,paceRatio:1,pronunciationNotes:[],normalizedBeatRatio:1.01}];
 const selected=await api.testPick('run',{stem:'line',speaker:'威吉',text_jp:'日本語',text_zh:'原稿'},asr,rows,{qualifiedOptimizationPool:true});
 received=globalThis.__qualifiedPoolInput;assert.equal(selected.clip.id,'original');assert.deepEqual(received.candidates.map(x=>x.ttsId),['original','optimized']);assert.deepEqual(received.candidates[0].pronunciationNotes,['一个可容忍疑点']);assert.equal(received.qualifiedOptimizationPool,true);
 const messages=rhythmPickMessages({...input(),qualifiedOptimizationPool:true});assert.ok(messages.some(x=>!x.promptKey&&x.content.includes('优化稿不因比更接近1就自动优先')));
});
