const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const normal=require('./normal-speed-beat.ts'),m=new Module(__filename);m.require=()=>normal;
m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/fast-long-pressure.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
const {fastLongPressure:check,fastLongPromptValues:values}=m.exports;
const input=()=>({netRate:8.45,hardSpeed:{enabled:true,pass:true},beat:{ratio:.7,low:.85}});
test('正常区间同源；硬限通过但偏快+中文偏长触发，不用另一套范围',()=>{
 assert.deepEqual(values(),{normal_low:normal.NORMAL_CHINESE_BEAT_SPEED_LOW,normal_high:normal.NORMAL_CHINESE_BEAT_SPEED_HIGH});
 assert.equal(check(input()).triggered,true);assert.equal(check({...input(),netRate:normal.NORMAL_CHINESE_BEAT_SPEED_HIGH}).triggered,false);
});
test('低于正常下限、比偏高/合格、比不可算或硬限未通过，不套联合改短',()=>{
 for(const rate of [4,4.5,6,7,null,NaN])assert.equal(check({...input(),netRate:rate}).triggered,false);
 for(const ratio of [.85,1,1.3,null,NaN,0])assert.equal(check({...input(),beat:{ratio,low:.85}}).triggered,false);
 assert.equal(check({...input(),hardSpeed:{enabled:true,pass:false}}).triggered,false);
 assert.equal(check({...input(),hardSpeed:{enabled:false,pass:true}}).triggered,false);
 assert.equal(check({...input(),beat:{ratio:.7,low:.75}}).triggered,true);
 assert.equal(check({...input(),beat:{ratio:.75,low:.75}}).triggered,false);
});
test('提示词渲染引用正常区间常量；未知比值不在提示词中补造',()=>{
 const row=require('./prompt-seed.test.json').find(r=>r.key==='rewrite.fast-long-pressure'),{renderPrompt}=require('./prompt-template.ts');
 const prompt=renderPrompt(row.prompt,values());assert.ok(prompt.includes(`${normal.NORMAL_CHINESE_BEAT_SPEED_LOW}–${normal.NORMAL_CHINESE_BEAT_SPEED_HIGH}`));
 assert.match(prompt,/不从日文拍数重算、猜测或伪造比值/);assert.match(prompt,/比值单独豁免/);
 assert.equal(check({...input(),evidenceVerified:false}).triggered,false);
});
