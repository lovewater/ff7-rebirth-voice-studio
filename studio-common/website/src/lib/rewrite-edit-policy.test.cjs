/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const cache=new Map();function load(file){if(cache.has(file))return cache.get(file).exports;const m=new Module(file);cache.set(file,m);m.require=id=>id.startsWith('./')?load(path.resolve(path.dirname(file),id+'.ts')):require(id);m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return m.exports;}
const {rewriteEditPolicy:policy,rewriteEditInstruction:instruction}=load(__dirname+'/rewrite-edit-policy.ts');
function input(id='a',draft='d'){return{draftId:draft,script:'我们塔克斯必须一直\n做出正确且客观的判断',requiredChecks:['text','parts','length','beat'],measurement:{draftId:draft,audioId:id,netRate:7.5,text:{pass:true},hardSpeed:{enabled:true,pass:true},parts:{required:2,actual:2,checks:[{index:1,status:'correct',deltaSeconds:0},{index:2,status:'correct',deltaSeconds:0}]},length:{pass:true,deltaSeconds:0},beat:{enabled:true,ratio:1,low:.85,high:1.15}}};}
test('usable warnings including exactly 300ms get only local polish',()=>{const a=input();a.measurement.parts.checks[1]={index:2,status:'warning',deltaSeconds:-.3};assert.equal(policy([a]).mode,'local-polish');assert.match(instruction([a]),/最小必要的局部/);});
test('second-to-third batch allows substantial retiming but preserves sound original wording',()=>{const a=input();a.measurement.parts.checks=[{index:1,status:'warning',deltaSeconds:.1},{index:2,status:'error',deltaSeconds:-.5}];a.measurement.length.pass=false;a.measurement.length.deltaSeconds=-.4;assert.equal(policy([a]).mode,'timing-rewrite');assert.match(instruction([a]),/不要被最小改动限制住/);assert.match(instruction([a]),/相同字数的换词不能作为解决长度问题的理由/);});
test('301ms is not admitted even if supplied status is inconsistent',()=>{const a=input();a.measurement.parts.checks[1]={index:2,status:'warning',deltaSeconds:-.301};assert.equal(policy([a]).mode,'timing-rewrite');});
test('verified text with wrong count, boundary or layout needs structure work',()=>{for(const change of [{actual:3},{boundaryPass:false},{layoutPass:false}]){const a=input();Object.assign(a.measurement.parts,change);assert.equal(policy([a]).mode,'structure-rewrite');}});
test('missing or failed text verification never drives timing rewrite',()=>{const a=input();a.measurement.parts.actual=3;delete a.measurement.text;assert.equal(policy([a]).mode,'verify-first');a.measurement.text={pass:false,missing:['判断']};assert.equal(policy([a]).mode,'retry-original');});
test('missing part measurement cannot imply admission',()=>{const a=input();a.measurement.parts.checks.pop();assert.equal(policy([a]).mode,'verify-first');});
test('beat and hard speed failure remain hard constraints; normal speed exemption still applies',()=>{const a=input();a.measurement.beat.ratio=.7;assert.equal(policy([a]).mode,'constraint-rewrite');a.measurement.netRate=5.5;assert.equal(policy([a]).mode,'local-polish');a.measurement.hardSpeed.pass=false;assert.equal(policy([a]).mode,'constraint-rewrite');});
test('one usable take can win but good parts of different takes cannot be combined',()=>{const a=input('a'),b=input('b');a.measurement.parts.checks[1]={index:2,status:'error',deltaSeconds:-.5};b.measurement.parts.checks[0]={index:1,status:'error',deltaSeconds:.5};assert.equal(policy([a,b]).mode,'timing-rewrite');const good=input('good');assert.equal(policy([a,good,b]).audioId,'good');assert.equal(policy([a,good,b]).mode,'local-polish');});
test('new drafts never inherit old passing audio; explicit script chooses its own evidence',()=>{const a=input('old','old'),b=input('new','new');b.script='新稿';b.measurement.parts.checks[1]={index:2,status:'error',deltaSeconds:-.6};assert.equal(policy([a,b]).mode,'timing-rewrite');assert.equal(policy([a,b],a.script).mode,'local-polish');assert.equal(policy([a,b],'尚未合成的稿'),null);});
test('assembly failure overrides earlier usable timing for the same audio',()=>{const a=input();a.requiredChecks.push('assembly');a.measurement.assembly={pass:false,failure:'cannot-fit-gaps'};assert.equal(policy([a]).mode,'structure-rewrite');a.measurement.assembly.failure='unknown';assert.equal(policy([a]).mode,'verify-first');});
test('absence of explicit length or hard speed evidence cannot select local polish',()=>{for(const key of ['length','hardSpeed']){const a=input();if(key==='length')a.requiredChecks=a.requiredChecks.filter(k=>k!=='length');delete a.measurement[key];assert.equal(policy([a]).mode,'verify-first');}});
test('结构重写诊断不能覆盖尚未解禁的标点权限；解禁后才传整体改写指令',()=>{
 const a=input();a.measurement.parts.actual=1;
 const restricted=instruction([a],a.script,false);
 assert.match(restricted,/仅允许调整标点/);assert.doesNotMatch(restricted,/允许重建断句、重新分配/);
 const unlocked=instruction([a],a.script,true);
 assert.match(unlocked,/允许重建断句、重新分配/);assert.match(unlocked,/"allowRewrite":true/);
});

const {timingCharacterSuggestions:characterAdvice}=load(__dirname+'/rewrite-edit-policy.ts');
function singleReading(script='妈妈，不要',candidate=.768,reference=1.133){return {draftId:'d',script,requiredChecks:['text','length','beat'],measurement:{draftId:'d',audioId:'audio',netRate:5.2,text:{pass:true},hardSpeed:{enabled:true,pass:true},length:{pass:true,deltaSeconds:0},beat:{enabled:false,ratio:null,low:.85,high:1.15},readingLength:{pass:false,candidateSeconds:candidate,referenceSeconds:reference,deltaSeconds:candidate-reference}}};}
test('short verified line gets five-to-six soft characters, starting from smaller edit instead of blind expansion',()=>{
 const a=singleReading(),suggestions=characterAdvice(a);assert.deepEqual(suggestions.map(r=>[r.current,r.low,r.high,r.deltaLow,r.deltaHigh]),[[4,5,6,1,2]]);
 assert.equal(policy([a]).mode,'timing-rewrite');const prompt=instruction([a],a.script,true);assert.match(prompt,/建议先尝试5–6字，约增加1–2字/);assert.match(prompt,/不是最低字数或硬上限/);assert.match(prompt,/允许自然补全或合并表达/);assert.match(prompt,/新稿必须重新TTS核字和实测/);
 assert.doesNotMatch(instruction([a],a.script,false),/【时长改稿参考字数/);
});
test('long line suggests fewer characters; passed or missing measurements do not invent targets',()=>{
 const a=singleReading('妈妈，不要你别走',1.4,1);assert.deepEqual(characterAdvice(a).map(r=>[r.current,r.low,r.high]),[[7,5,5]]);
 a.measurement.readingLength.pass=true;assert.deepEqual(characterAdvice(a),[]);a.measurement.readingLength.pass=false;delete a.measurement.readingLength.referenceSeconds;assert.deepEqual(characterAdvice(a),[]);
});
test('unverified text, wrong draft, unknown readings and contradictory measurements cannot drive character targets',()=>{
 for(const change of [a=>a.measurement.text.pass=false,a=>a.measurement.draftId='other',a=>a.script='妈妈，别走2步',a=>a.measurement.readingLength.deltaSeconds=1,a=>a.measurement.readingLength.referenceSeconds=NaN,a=>a.measurement.hardSpeed.pass=false]){const a=singleReading();change(a);assert.deepEqual(characterAdvice(a),[]);}
 const a=singleReading();a.measurement.netRate=7.5;a.measurement.beat={enabled:true,ratio:.5,low:.85,high:1.15};assert.deepEqual(characterAdvice(a),[]);
});
test('two and three parts only estimate failed segments with matching verified boundaries',()=>{
 for(const n of [2,3]){const a=input();a.script=['妈妈','不要走','等一等'].slice(0,n).join('\n');a.measurement.parts={required:n,actual:n,texts:a.script.split('\n'),checks:Array.from({length:n},(_,i)=>({index:i+1,status:i===1?'error':'correct',deltaSeconds:i===1?-.4:0,originalSeconds:i===1?.6:1,referenceSeconds:1}))};const result=characterAdvice(a);assert.equal(result.length,1);assert.equal(result[0].part,2);assert.equal(result[0].current,3);assert.equal(result[0].low,5);a.measurement.parts.boundaryPass=false;assert.deepEqual(characterAdvice(a),[]);}
});

test('legacy replay is explicitly labelled and a one-character line cannot be shortened to zero',()=>{const a=singleReading();a.measurement.netLength=a.measurement.readingLength;delete a.measurement.readingLength;assert.equal(characterAdvice(a)[0].timingBasis,'legacy-net-speech');assert.deepEqual(characterAdvice(singleReading('嗯',2,1)),[]);});

function gilgamesh(){const a=input();a.script='我们基本上都是，放着不管的';a.measurement.parts={required:2,actual:2,texts:['我们基本上都是。','放着不管的。'],layoutPass:false,checks:[{index:1,status:'error',deltaSeconds:.516172619,originalSeconds:1.426349206,referenceSeconds:.696208333},{index:2,status:'correct',deltaSeconds:-.000017,originalSeconds:.92,referenceSeconds:.894166667}]};return a;}
test('吉尔伽美什岛回归：组装失败保留可靠的第一段压缩建议，第二段保持',()=>{
 const a=gilgamesh(),p=policy([a]);assert.equal(p.mode,'structure-rewrite');
 assert.deepEqual(p.characterSuggestions.map(r=>[r.part,r.current,r.low,r.high]),[[1,7,3,4]]);
 assert.deepEqual(p.partDirections,[{part:1,direction:'shorten'},{part:2,direction:'keep'}]);
 const prompt=instruction([a],a.script,true);assert.match(prompt,/第1段：实测偏长，本轮精简该段/);assert.match(prompt,/第2段：实测时长已合格，保持该段正文与节奏/);
 assert.match(prompt,/建议先尝试3–4字/);assert.match(prompt,/不得为凑段数添加新的句子、事实/);
 assert.doesNotMatch(prompt,/允许重建断句、重新分配|不要受最小改动限制/);
 const restricted=instruction([a],a.script,false);assert.match(restricted,/仅允许调整标点/);assert.doesNotMatch(restricted,/【本轮逐段改稿任务|【时长改稿参考字数/);
});
test('组装失败仍不允许错位、漏字、缺测或旧稿产生逐段改稿方向',()=>{
 for(const change of [a=>a.measurement.parts.boundaryPass=false,a=>a.measurement.parts.actual=1,a=>a.measurement.text.pass=false,a=>a.measurement.draftId='old',a=>delete a.measurement.parts.checks[0].originalSeconds,a=>a.measurement.parts.checks[0].deltaSeconds=-.5]){
  const a=gilgamesh();change(a);assert.deepEqual(policy([a]).partDirections,[]);assert.deepEqual(characterAdvice(a),[]);
 }
});
test('一段长一段短分别下发方向，不按总长抵消；三段也适用',()=>{
 const a=gilgamesh();a.measurement.parts.checks[1]={index:2,status:'error',deltaSeconds:-.4,originalSeconds:.5,referenceSeconds:.9};
 assert.deepEqual(policy([a]).partDirections,[{part:1,direction:'shorten'},{part:2,direction:'lengthen'}]);
 assert.match(instruction([a],a.script,true),/第2段：实测偏短，先调整自然停顿/);
 a.measurement.parts.required=a.measurement.parts.actual=3;a.measurement.parts.checks.push({index:3,status:'correct',deltaSeconds:0});
 assert.deepEqual(policy([a]).partDirections.at(-1),{part:3,direction:'keep'});
});
