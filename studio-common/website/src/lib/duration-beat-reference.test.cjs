/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),ts=require('typescript'),fs=require('node:fs');
const {clearlyShortSpeakingRound:short,durationRewritePolicy}=require('./auto-run-script-policy.ts');
test('clear shortage requires >200ms AND below85%, valid waveform evidence, and all reliable candidates',()=>{
 const r=(jp,cn)=>({referenceSeconds:jp,candidateSeconds:cn});
 assert.equal(short([r(3.77,2.989)]),true);assert.equal(short([r(1,.8)]),false);assert.equal(short([r(4,3.4)]),false);
 assert.equal(short([r(4,3),r(4,4)]),false);assert.equal(short([]),false);assert.equal(short([r(0,1)]),false);assert.equal(short([r(4,NaN)]),false);
 assert.equal(durationRewritePolicy('怎么样啊，这才是做生意！',3.77,2.989).target,13);
});
function load(name){
 if(name==='./auto-run-two-parts')return{performanceRewriteMessages:m=>m};
 if(name==='./rewrite-translation-reference')return{withTranslationReferences:async m=>m};
 if(name==='./llm-chat-client')return{callChatCompletion:async input=>{
  const response=await global.fetch('http://test.invalid',{method:'POST',body:JSON.stringify(input)});
  const result=await response.json();return{content:result.choices[0].message.content,thinking:''};
 }};
 if(name==='./prompt-store')return require('./prompt-test-store.cjs');
 if(name==='./llm-metrics')return{currentLlmStem:()=>undefined,beginLlmCall:async()=> 'test-log',recordLlmCall:async()=>{}};
 if(name==='./tts-gpu')return{normalizeScript:t=>({ttsText:t})};
 const m=new Module(__filename);m.require=id=>id.startsWith('./')?load(id):require(id);
 m._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/${name.slice(2)}.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,`${__dirname}/${name}.ts`);return m.exports;
}
for(const brokenMeasure of [false,true])test('five rewrites may select the 14-character manual answer despite ratio .728, including unavailable diagnostic beats: '+brokenMeasure,async()=>{
 const texts=['怎么样啊，这才是做生意！','怎么样啊，这才是堂堂正正做生意！','怎么样啊，这才是真正堂堂正正做生意！','看到了吧，这就叫做生意！','怎么样啊？这才是做生意！'];
 const originalFetch=global.fetch,oldUrl=process.env.VOLCENGINE_LLM_URL,oldKey=process.env.VOLCENGINE_LLM_KEY;let n=0;
 process.env.VOLCENGINE_LLM_URL='http://test.invalid';process.env.VOLCENGINE_LLM_KEY='test';
 global.fetch=async(_url,opts)=>{const prompt=JSON.parse(opts.body).messages.map(m=>m.content).join('\n');assert.doesNotMatch(prompt,/正常范围是 0\.9|目标约.*拍|字幕拍数必须落在|后续必须在合格范围内/);assert.match(prompt,/建议约13字，仅供参考，不强制/);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({text:texts[n++]})}}]}));};
 try{const beat={jp:{status:'ok',units:15},cn:{units:11.5},normalizedRatio:.981};
 const r=await load('./auto-run-llm').rewriteFive({speaker:'贝格',show:null,textJp:'どうだおまえら これがショーバイだ！',textEn:"That's how you broker an honest deal!",original:texts[0],current:texts[0],beats:beat,before:[],after:[],jpAsr:{raw:{}},failNotes:[],durationLine:durationRewritePolicy(texts[0],3.77,2.989),measure:async t=>{if(brokenMeasure)throw Error('拍数服务不可用');return{...beat,normalizedRatio:t===texts[1]?.728:.981};}});
 assert.equal(n,5);assert.equal(r.text,texts[1]);assert.equal(r.target,13);assert.equal(r.candidates[1].ratio,brokenMeasure?null:.728);
 }finally{global.fetch=originalFetch;if(oldUrl===undefined)delete process.env.VOLCENGINE_LLM_URL;else process.env.VOLCENGINE_LLM_URL=oldUrl;if(oldKey===undefined)delete process.env.VOLCENGINE_LLM_KEY;else process.env.VOLCENGINE_LLM_KEY=oldKey;}
});
test('慢速冲突分支五稿不再被旧5字目标拉回，仍保留字符上限',async()=>{
 const texts=['你这个臭老头子','甲乙丙丁戊','甲乙丙丁戊己庚辛壬','你这个坏老头','你这臭老头'];
 const oldFetch=global.fetch,oldUrl=process.env.VOLCENGINE_LLM_URL,oldKey=process.env.VOLCENGINE_LLM_KEY;let n=0;
 process.env.VOLCENGINE_LLM_URL='http://test.invalid';process.env.VOLCENGINE_LLM_KEY='test';
 global.fetch=async(_url,opts)=>{const prompt=JSON.parse(opts.body).messages.map(m=>m.content).join('\n');
  assert.doesNotMatch(prompt,/补足到接近或等于|正文尽量接近或等于/);assert.match(prompt,/程序已确认/);
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({text:texts[n++]})}}]}));};
 try{
  const beat={jp:{status:'short',units:null},cn:{units:6},normalizedRatio:null};
  const r=await load('./auto-run-llm').rewriteFive({speaker:'',show:null,textJp:'このジジイ～！',textEn:'',original:'你这个臭老头',current:'你这个臭老头',beats:beat,before:[],after:[],jpAsr:{raw:{}},failNotes:[],slowLine:{jpMora:5,target:5,max:8,speechSeconds:2.317,moraPerSecond:2.158,durationDirection:'longer'},measure:async()=>beat});
  assert.equal(n,5);assert.equal(r.text,texts[0]);assert.equal(r.target,null);
 }finally{global.fetch=oldFetch;if(oldUrl===undefined)delete process.env.VOLCENGINE_LLM_URL;else process.env.VOLCENGINE_LLM_URL=oldUrl;if(oldKey===undefined)delete process.env.VOLCENGINE_LLM_KEY;else process.env.VOLCENGINE_LLM_KEY=oldKey;}
});
test('中文净语速正常的改稿不再按比筛选，只改一稿后回TTS，不继承旧音频合格状态',async()=>{
 const previous=global.fetch;let calls=0;
 global.fetch=async(_url,opts)=>{calls++;const messages=JSON.parse(opts.body).messages.map(m=>m.content).join('\n');
  assert.match(messages,/4.5～7.0/);assert.match(messages,/新稿尚未TTS/);assert.match(messages,/候选甲/);
  assert.doesNotMatch(messages,/中文目标拍数|目标比值|双达标区间/);
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({text:'这真是让人头疼的难题呀\n看来还得再给你们添一道新课题'})}}]}));
 };
 try {
  const beat={jp:{status:'ok',units:28},cn:{han:25,units:28},normalizedRatio:.752};
  const r=await load('./auto-run-llm').rewriteFive({speaker:'仙人',show:null,textJp:'それは困った問題じゃの',textEn:'',original:'那问题可大了',current:'旧朗读稿',beats:beat,before:[],after:[],jpAsr:{raw:{}},failNotes:['长度仍需调整，比已忽略'],normalSpeedLine:{candidateId:'候选甲',script:'旧朗读稿',rate:5.5,netSeconds:4.5,referenceSeconds:4.7,candidateSeconds:4.5},measure:async()=>beat});
  assert.equal(calls,1);assert.equal(r.candidates.length,1);assert.equal(r.target,null);assert.equal(r.pickedInBand,true);
 }finally{global.fetch=previous;}
});
test('历史驱动改稿只请求一稿，不携带旧比值目标和冲突的旧failNotes',async()=>{
 const old=global.fetch;let calls=0;
 global.fetch=async(_url,opts)=>{calls++;const text=JSON.parse(opts.body).messages.map(m=>m.content).join('\n');
  assert.match(text,/已有的尝试和出现的问题/);assert.match(text,/每次只提出一个新稿/);
  assert.doesNotMatch(text,/STALE_FAIL_NOTE|STALE_DIRECTION|双达标区间/);
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({text:'这真是让人头疼的问题呀\n看来还得再给你们一道考验'})}}]}));
 };
 try{
  const beat={jp:{status:'ok',units:28},cn:{units:29},normalizedRatio:.7};
  const r=await load('./auto-run-llm').rewriteFive({speaker:'仙人',show:null,textJp:'原始日文',textEn:'Original English',original:'原始中文',current:'当前稿',beats:beat,before:[],after:[],jpAsr:{raw:{}},failNotes:['STALE_FAIL_NOTE'],extraUser:'STALE_DIRECTION',attemptHistoryMode:true,measure:async()=>beat});
  assert.equal(calls,1);assert.equal(r.target,null);assert.equal(r.text,'这真是让人头疼的问题呀\n看来还得再给你们一道考验');
 }finally{global.fetch=old;}
});
