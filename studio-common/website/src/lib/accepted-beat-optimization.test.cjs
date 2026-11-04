/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
function setup(responses=[]){const cache=new Map(),calls=[];function load(file){if(cache.has(file))return cache.get(file).exports;const m=new Module(file);cache.set(file,m);m.require=id=>{
 if(id==='./llm-chat-client')return{callChatCompletion:async request=>{calls.push(structuredClone(request));const value=responses.shift();if(value instanceof Error)throw value;return {content:typeof value==='string'?value:JSON.stringify(value)};}};
 return id.startsWith('./')?load(path.resolve(path.dirname(file),id+'.ts')):require(id);
 };m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return m.exports;}
 return {...load(__dirname+'/accepted-beat-optimization.ts'),calls};}
const args={stem:'test',qualifiedFinalId:'saved-final',script:'你也和我们一样，替这个星球着想──',requiredParts:1,policy:'lines',normalizedRatio:1.358,textJp:'星の未来',textEn:'the future',originalChinese:'你也和我们一样，替这个星球着想──',japaneseChineseTranslation:'为星球的未来着想',englishChineseTranslation:'星球的未来',speaker:'威吉',noOriginalChinese:false};
const faithful={faithful:true,needsHuman:false,missingMeaning:[],addedMeaning:[],changedMeaning:[],reason:'只展开源文已有的未来含义'};
test('gate requires a saved qualified final, reliable out-of-band ratio and one three-clip batch budget',()=>{
 const c=setup(),valid={qualifiedFinal:true,ratio:1.358,band:{low:.85,high:1.15},shortOrSlow:false,availableSlots:3};assert.equal(c.acceptedBeatOptimizationGate(valid),null);
 for(const change of [{qualifiedFinal:false},{ratio:null},{ratio:NaN},{ratio:1},{shortOrSlow:true},{availableSlots:2}])assert.ok(c.acceptedBeatOptimizationGate({...valid,...change}));assert.equal(c.calls.length,0);
});
test('one meaning-preserving proposal may change character count and remains only an additional candidate',async()=>{
 const c=setup([{parts:['你也和我们一样，为这个星球的未来着想──'],reason:'补足日文已有的未来'},faithful]);const r=await c.proposeAcceptedBeatOptimization(args);
 assert.equal(r.changed,true);assert.match(r.script,/未来/);assert.equal(c.calls.length,2);assert.ok(c.calls.every(x=>x.attempts===1));
 assert.equal(c.calls[0].task,'accepted-beat-optimization');assert.equal(c.calls[1].task,'accepted-beat-meaning-review');assert.match(c.calls[0].messages[0].content,/新增候选，不是自动替换/);assert.match(c.calls[0].messages[1].content,/japaneseChineseTranslation/);
});
for(const verdict of [{...faithful,faithful:false},{...faithful,needsHuman:true},{...faithful,changedMeaning:['改变对象']},{...faithful,reason:''},{}])test(`meaning rejection retains originals: ${JSON.stringify(verdict)}`,async()=>{
 const c=setup([{parts:['随便加一句剧情']},verdict]);assert.equal((await c.proposeAcceptedBeatOptimization(args)).changed,false);assert.equal(c.calls.length,2);
});
test('invalid or unchanged draft stops after one proposal without correction requests',async()=>{
 for(const response of ['not json',{parts:['错误','数量']},{parts:[args.script]}]){const c=setup([response]);assert.equal((await c.proposeAcceptedBeatOptimization(args)).changed,false);assert.equal(c.calls.length,1);}
});
test('multipart proposal keeps part count but permits different word counts',()=>{
 const c=setup();assert.equal(c.validateAcceptedBeatParts(['第一段自然展开','第二段'],2).script,'第一段自然展开\n第二段');
 for(const parts of [['一段'],['第一\n第二','第三'],['第一[停顿=500]','第二'],['','第二']])assert.equal(c.validateAcceptedBeatParts(parts,2),null);
});
test('no-original mode does not reintroduce meaning comparison or neighbor context',async()=>{
 const c=setup([{parts:['仅依本句重新表达'],reason:'用本句译文起稿'}]);const r=await c.proposeAcceptedBeatOptimization({...args,originalChinese:null,noOriginalChinese:true});
 assert.equal(r.changed,true);assert.equal(r.meaningReview.applicable,false);assert.equal(c.calls.length,1);
 const input=JSON.parse(c.calls[0].messages[1].content);assert.equal(Object.hasOwn(input,'before'),false);assert.equal(Object.hasOwn(input,'after'),false);
});
test('a new qualified variant cannot displace originals merely because its ratio is closer to one',()=>{
 const c=setup(),original=[{clip:{id:'old-a'},ratio:1.358},{clip:{id:'old-b'},ratio:1.3}],fresh=[{clip:{id:'new'},ratio:1.01}];
 assert.deepEqual(c.mergeQualifiedOptimizationPool(original,fresh).map(x=>x.clip.id),['old-a','old-b','new']);assert.deepEqual(original.map(x=>x.clip.id),['old-a','old-b']);assert.deepEqual(c.mergeQualifiedOptimizationPool(original,[]),original);assert.equal(c.mergeQualifiedOptimizationPool(original,[original[0]]).length,2);
});
