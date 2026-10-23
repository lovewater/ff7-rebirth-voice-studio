/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const m=new Module(__filename);m.require=id=>id==='./normal-speed-beat'?require('./normal-speed-beat.ts'):require(id);
m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/attempt-feedback.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
const {calculateAttemptFeedback:calc,renderAttemptFeedback:render,summarizeDraftFeedback:group}=m.exports;
function input(){return {draftId:'稿1',script:'第一行正文\n第二行正文',requiredChecks:['text','parts','length','assembly','beat'],measurement:{draftId:'稿1',audioId:'音频1',netRate:7.5,text:{pass:true},parts:{required:2,actual:2,checks:[{index:1,status:'correct',deltaSeconds:0},{index:2,status:'correct',deltaSeconds:0}]},length:{pass:true,deltaSeconds:0},assembly:{pass:true,deltaSeconds:0},beat:{enabled:true,ratio:1,low:.85,high:1.15}}};}
function part(i,status,delta){return{index:i,status,deltaSeconds:delta};}
function reasons(r){return r.issues.map(i=>i.reason).join('');}
function advice(r){return r.suggestions.join('');}
test('实测比偏低翻译为字数过多，偏高翻译为字数不足，边界通过',()=>{
 for(const [ratio,code]of [[.6,'text-too-many'],[1.4,'text-too-few']]){const a=input();a.measurement.beat.ratio=ratio;assert.equal(calc(a).issues[0].code,code);}
 for(const ratio of [.85,1,1.15]){const a=input();a.measurement.beat.ratio=ratio;assert.equal(calc(a).status,'accepted');}
});
test('净语速4.5到7含边界时忽略比，区间外恢复比检查',()=>{
 for(const rate of [4.5,5.5,6,6.78,7]){const a=input();a.measurement.netRate=rate;a.measurement.beat.ratio=.4;const r=calc(a);assert.equal(r.status,'accepted');assert.equal(r.beatIgnored,true);}
 for(const rate of [4.49,7.01]){const a=input();a.measurement.netRate=rate;a.measurement.beat.ratio=.4;assert.equal(calc(a).status,'rejected');}
});
test('实测音频偏短不推断字数不足，第一段好时建议保持',()=>{
 const a=input();a.measurement.parts.checks[1]=part(2,'error',-.5);const r=calc(a);
 assert.equal(r.status,'rejected');assert.equal(reasons(r),'第二段音频偏短。');assert.doesNotMatch(reasons(r),/字数不足/);assert.match(advice(r),/第一段保持/);
});
test('同稿同时字数过多和音频偏短：只给精简与停顿方向，不反向要求加字',()=>{
 const a=input();a.measurement.beat.ratio=.6;a.measurement.parts.checks[1]=part(2,'error',-.5);const r=calc(a);
 assert.match(reasons(r),/字数过多/);assert.match(reasons(r),/第二段音频偏短/);assert.match(advice(r),/存在冲突/);assert.match(advice(r),/自然停顿/);
 assert.doesNotMatch(advice(r),/必要时适当增加|增加该段文字|第一段保持/);
});
test('字数不足但音频偏长：补足表达与收紧停顿，不同时指示精简文字',()=>{
 const a=input();a.measurement.beat.ratio=1.4;a.measurement.parts.checks[1]=part(2,'error',.6);const r=calc(a);
 assert.match(advice(r),/收紧/);assert.doesNotMatch(advice(r),/精简该段文字|必要时精简/);
});
test('不同分段一短一长不是同段互搏；不丢失任何一个分段的建议',()=>{
 const a=input();a.measurement.parts.checks=[part(1,'error',-.5),part(2,'error',.6)];const r=calc(a);
 assert.match(reasons(r),/第一段音频偏短/);assert.match(reasons(r),/第二段音频偏长/);assert.match(advice(r),/第一段/);assert.match(advice(r),/第二段/);
 a.measurement.beat.ratio=.6;const conflict=calc(a);assert.match(advice(conflict),/第二段.*精简/);assert.doesNotMatch(advice(conflict),/增加该段文字/);
});
test('第三段同样计算且只有警告时保留可用音频，不标退回',()=>{
 const a=input();a.measurement.parts={required:3,actual:3,checks:[part(1,'correct',0),part(2,'correct',0),part(3,'warning',-.2)]};const r=calc(a);
 assert.equal(r.status,'warning');assert.match(render([r]),/已有可用音频/);assert.doesNotMatch(render([r]),/退回原因/);assert.match(advice(r),/第一段、第二段保持/);
});
test('片数错误时不引用错位的第一/二段时长，优先修结构而非强行增减字',()=>{
 const a=input();a.measurement.parts={required:2,actual:3,checks:[part(1,'error',-.9),part(2,'error',.8)]};a.measurement.beat.ratio=.6;
 const r=calc(a);assert.match(reasons(r),/需要2段，实际为3段/);assert.doesNotMatch(reasons(r),/第一段音频|第二段音频/);assert.doesNotMatch(advice(r),/精简|增加文字/);
});
test('全部分段警告但最终组装失败升级退回；正常分段不应被无依据改字',()=>{
 const a=input();a.measurement.parts.checks[1]=part(2,'warning',-.2);a.measurement.assembly={pass:false,deltaSeconds:-.4};const r=calc(a);
 assert.equal(r.status,'rejected');assert.match(reasons(r),/最终音频偏短/);assert.match(advice(r),/首尾和段间留白/);
});
test('拼装装不下空白给对应建议，不装作语义需要加字',()=>{
 const a=input();a.measurement.assembly={pass:false,failure:'cannot-fit-gaps'};const r=calc(a);assert.match(reasons(r),/无法保留必要/);assert.match(advice(r),/精简过长分片/);
});
test('校字硬伤不能把漏读造成的偏短误导为需要增加台词',()=>{
 const a=input();a.measurement.text={pass:false,missing:['正文']};a.measurement.parts.checks[1]=part(2,'error',-.9);a.measurement.beat.ratio=1.4;
 const r=calc(a);assert.equal(r.status,'rejected');assert.equal(r.issues.length,1);assert.match(advice(r),/保持正确台词/);assert.doesNotMatch(advice(r),/适当增加|精简/);
 a.measurement.text={pass:true,missing:['正文']};assert.equal(calc(a).status,'rejected');
});
test('净语速正常不能覆盖校字、结构、时长或组装错误',()=>{
 for(const modify of [a=>a.measurement.text={pass:false},a=>a.measurement.parts.actual=1,a=>a.measurement.length={pass:false,deltaSeconds:-.5},a=>a.measurement.assembly={pass:false,failure:'unknown'}]){
  const a=input();a.measurement.netRate=5.5;a.measurement.beat.ratio=.3;modify(a);const r=calc(a);assert.equal(r.beatIgnored,true);assert.equal(r.status,'rejected');
 }
});
test('缺音频、错稿音频、缺校字、缺语速或无效数字都不能假称通过',()=>{
 const a=input();delete a.measurement;assert.equal(calc(a).status,'pending');assert.doesNotMatch(render([calc(a)]),/退回原因/);
 const b=input();b.measurement.draftId='别稿';assert.equal(calc(b).status,'invalid');
 const c=input();delete c.measurement.text;assert.equal(calc(c).status,'pending');
 const d=input();d.measurement.netRate=null;assert.equal(calc(d).status,'pending');assert.doesNotMatch(reasons(calc(d)),/字数过多/);
 const e=input();e.measurement.parts.checks[1].deltaSeconds=NaN;assert.equal(calc(e).status,'pending');
 const f=input();f.requiredChecks=[];assert.equal(calc(f).status,'pending');
});
test('未测比在已实测净语速正常时不阻断，其余情况不能假装字数合适',()=>{
 const a=input();a.measurement.beat.ratio=null;assert.equal(calc(a).status,'pending');a.measurement.netRate=5.5;assert.equal(calc(a).status,'accepted');
});
test('同稿三次只要一条可用就不整体退回；不同稿件不得混用',()=>{
 const a=input();a.measurement.parts.checks[1]=part(2,'error',-.5);const b=input();b.measurement.audioId='音频2';const out=group([calc(a),calc(b)]);
 assert.equal(out.length,1);assert.equal(out[0].status,'accepted');assert.equal(out[0].audioIds.length,2);assert.doesNotMatch(render(out),/退回原因/);
 const c=input();c.draftId='稿2';c.measurement.draftId='稿2';assert.equal(group([calc(a),calc(c)]).length,2);
});
test('同稿只有警告也保留，不被另一条硬错误覆盖',()=>{
 const a=input();a.measurement.parts.checks[1]=part(2,'error',-.5);const b=input();b.measurement.parts.checks[1]=part(2,'warning',-.2);assert.equal(group([calc(a),calc(b)])[0].status,'warning');
});
test('同稿多次长短方向相反时建议先重试，不同时增字减字',()=>{
 const a=input();a.measurement.parts.checks[1]=part(2,'error',-.5);const b=input();b.measurement.parts.checks[1]=part(2,'error',.5);
 const r=group([calc(a),calc(b)])[0];assert.equal(r.issues[0].code,'generation-unstable');assert.match(advice(r),/保持台词重试/);
});
test('同稿ID对应不同文本时阻止合并，函数不修改输入',()=>{
 const a=input(),before=JSON.stringify(a);const r=calc(a);assert.equal(JSON.stringify(a),before);
 assert.throws(()=>group([r,{...r,script:'另一份台词'}]),/不同台词/);
});
test('渲染只给简明问题和建议，不把比值、缩放过程和内部ID塞入prompt',()=>{
 const a=input();a.measurement.parts.checks[1]=part(2,'error',-.5);const text=render([calc(a)]);
 assert.match(text,/退回原因：第二段音频偏短/);assert.match(text,/建议改进/);assert.doesNotMatch(text,/0\.85|1\.15|拉长到|缩放|音频1|稿1/);
});
test('625种比值×净语速×分段误差组合，不产生方向相反的加减字建议',()=>{
 for(const ratio of [.5,.85,1,1.15,1.6])for(const rate of [4,4.5,5.5,6,6.5,7,7.5])for(const d1 of [-.5,-.2,0,.2,.5])for(const d2 of [-.5,-.2,0,.2,.5]){
  const a=input();a.measurement.beat.ratio=ratio;a.measurement.netRate=rate;a.measurement.parts.checks=[d1,d2].map((d,i)=>part(i+1,d===0?'correct':Math.abs(d)<=.3?'warning':'error',d));const r=calc(a),s=advice(r);
  if(rate>=4.5&&rate<=7)assert.equal(r.issues.some(i=>['text-too-many','text-too-few'].includes(i.code)),false);
  else if(ratio<.85)assert.doesNotMatch(s,/必要时适当增加|增加该段文字/);
  else if(ratio>1.15)assert.doesNotMatch(s,/精简该段文字|必要时精简/);
 }
});
test('历史长稿字多、短稿时长不足时，联合建议寻找折中，不只服从最后一次失败',()=>{
 const a=input();a.measurement.beat.ratio=.6;const b=input();b.draftId='稿2';b.measurement.draftId='稿2';b.measurement.parts.checks[1]=part(2,'error',-.5);
 for(const history of [[calc(a),calc(b)],[calc(b),calc(a)]]){
  const r=m.exports.calculateHistoryGuidance(history);assert.equal(r.conflict,true);assert.match(r.suggestions.join(''),/不要在失败长稿和短稿之间来回切换/);
  assert.match(render(history),/综合改进方向/);
 }
});
test('历史已经有可用稿时，别稿的退回原因不能推翻它',()=>{
 const a=input();a.measurement.beat.ratio=.6;const b=input();b.draftId='稿2';b.measurement.draftId='稿2';
 const r=m.exports.calculateHistoryGuidance([calc(a),calc(b)]);assert.deepEqual(r.canKeep,['稿2']);assert.equal(r.conflict,false);assert.match(r.suggestions.join(''),/保留/);
});
test('全局高语速与字数不足冲突时不同时给加字和减字动作',()=>{
 const a=input();a.measurement.hardSpeed={enabled:true,pass:false};a.measurement.beat.ratio=1.4;
 const r=calc(a);assert.match(advice(r),/要求冲突/);assert.equal(r.suggestions.length,1);
});
test('跨稿互搏时逐条建议也统一裁决，不能只在段尾提示折中而正文仍指示加字',()=>{
 const a=input();a.measurement.beat.ratio=.6;const b=input();b.draftId='稿2';b.measurement.draftId='稿2';b.measurement.parts.checks[1]=part(2,'error',-.5);
 const text=render([calc(a),calc(b)]);assert.doesNotMatch(text,/必要时适当增加该段文字/);assert.match(text,/不删回已证实发声不足/);assert.match(text,/不恢复字数过多/);
});
test('净语速豁免只忽略比，不覆盖短句字符上下限和净发声时长',()=>{
 const a=input();a.measurement.netRate=5.5;a.measurement.beat.ratio=.6;a.measurement.characters={count:12,min:3,max:8};
 assert.match(reasons(calc(a)),/字数过多/);assert.equal(calc(a).status,'rejected');
 delete a.measurement.characters;a.measurement.netLength={pass:false,deltaSeconds:-.7};assert.match(reasons(calc(a)),/净发声时间偏短/);
});

test('共同字数过多不能被局部正确/警告状态差异抹掉，复现0500和1900',()=>{
 const a=input(),b=input();a.measurement.beat.ratio=b.measurement.beat.ratio=.78;
 a.measurement.parts.checks[0]=part(1,'warning',.02);
 const r=group([calc(a),calc(b)])[0];assert.match(reasons(r),/字数过多/);assert.doesNotMatch(advice(r),/保持台词重试/);
 assert.match(render([calc(a),calc(b)]),/第一段：时长正确/);assert.match(render([calc(a),calc(b)]),/第二段：时长正确/);
});
test('第一段稳定偏短、第二段方向变化，只中和第二段，不抹掉第一段',()=>{
 const a=input(),b=input();a.measurement.parts.checks=[part(1,'error',-.5),part(2,'error',-.5)];b.measurement.parts.checks=[part(1,'error',-.5),part(2,'error',.5)];
 const r=group([calc(a),calc(b)])[0];assert.ok(r.issues.some(i=>i.code==='part-short'&&i.part===1));assert.ok(r.issues.some(i=>i.code==='generation-unstable'&&i.part===2));assert.match(advice(r),/调整第一段/);
});
test('一个待验证候选不能覆盖已有明确失败；三段逐段说清楚好坏',()=>{
 const a=input();a.measurement.parts={required:3,actual:3,checks:[part(1,'correct',0),part(2,'error',-.5),part(3,'warning',.1)]};
 const b=input();delete b.measurement.text;
 const text=render([calc(a),calc(b)]);assert.match(text,/第一段：时长正确/);assert.match(text,/第二段：错误：音频偏短/);assert.match(text,/第三段：警告：音频偏长/);assert.match(text,/第二段音频偏短/);
});
test('恰好目标片数但切口错位，不把错误对应的长短反馈给模型',()=>{
 const a=input();a.measurement.parts.boundaryPass=false;a.measurement.parts.checks=[part(1,'error',-4),part(2,'error',2)];
 const r=calc(a);assert.ok(r.issues.some(i=>i.code==='parts-boundary'));assert.doesNotMatch(reasons(r),/第一段音频偏短|第二段音频偏长/);assert.match(render([r]),/第一段：尚未确认/);assert.doesNotMatch(advice(r),/适当增加|精简该段/);
});

test('实际钢琴支线：按对应中文段原始发声估算约7字，只显示整数软建议',()=>{
 const a=input();a.script='这些孩子就，拜托你了';a.measurement.parts.texts=['这些孩子就','拜托你了'];
 a.measurement.parts.checks=[{...part(1,'warning',-.136),originalSeconds:.777,referenceSeconds:1.030},{...part(2,'error',-.402),originalSeconds:.635,referenceSeconds:1.132}];
 const r=calc(a);assert.equal(r.partResults[1].suggestedCharacters,7);assert.match(render([r]),/第二段：.*本段建议约7字/);assert.doesNotMatch(render([r]),/7[～–-]8字/);
});
test('偏长时减字；缺测量、错误边界、漏字、混合数字和旧稿均不产生字数建议',()=>{
 const a=input();a.script='这些孩子就拜托你照顾了';a.measurement.parts.texts=['这些孩子','就拜托你照顾了'];
 a.measurement.parts.checks=[part(1,'correct',0),{...part(2,'error',.5),originalSeconds:1.8,referenceSeconds:1.1}];
 assert.equal(calc(a).partResults[1].suggestedCharacters,4);
 for(const mutate of [x=>delete x.measurement.parts.checks[1].originalSeconds,x=>x.measurement.parts.boundaryPass=false,x=>x.measurement.parts.actual=3,x=>x.measurement.text={pass:false,missing:['你']},x=>x.measurement.draftId='旧稿',x=>x.script='另一个稿',x=>{x.script='这些孩子就拜托你照顾2天';x.measurement.parts.texts[1]='就拜托你照顾2天';}]){
  const b=structuredClone(a);mutate(b);assert.doesNotMatch(render([calc(b)]),/本段建议约/);
 }
});
test('同稿同段生成长短相反时不展示互相冲突的字数建议',()=>{
 const a=input();a.script='这些孩子就，拜托你了';a.measurement.parts.texts=['这些孩子就','拜托你了'];
 a.measurement.parts.checks[1]={...part(2,'error',-.4),originalSeconds:.635,referenceSeconds:1.132};
 const b=structuredClone(a);b.measurement.audioId='另一次';b.measurement.parts.checks[1]={...part(2,'error',.4),originalSeconds:1.8,referenceSeconds:1.132};
 assert.doesNotMatch(render([calc(a),calc(b)]),/本段建议约/);
});
