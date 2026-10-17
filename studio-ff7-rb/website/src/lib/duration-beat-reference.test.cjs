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
 if(name==='./prompt-store')return require('./prompt-test-store.cjs');
 if(name==='./llm-metrics')return{beginLlmCall:async()=> 'test-log',recordLlmCall:async()=>{}};
 if(name==='./tts-gpu')return{normalizeScript:t=>({ttsText:t})};
 const m=new Module(__filename);m.require=id=>id.startsWith('./')?load(id):require(id);
 m._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/${name.slice(2)}.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,`${__dirname}/${name}.ts`);return m.exports;
}
for(const brokenMeasure of [false,true])test('five rewrites may select the 14-character manual answer despite ratio .728, including unavailable diagnostic beats: '+brokenMeasure,async()=>{
 const texts=['怎么样啊，这才是做生意！','怎么样啊，这才是堂堂正正做生意！','怎么样啊，这才是真正堂堂正正做生意！','看到了吧，这就叫做生意！','怎么样啊？这才是做生意！'];
 const originalFetch=global.fetch,oldUrl=process.env.REWRITE_LLM_URL,oldKey=process.env.REWRITE_LLM_KEY;let n=0;
 process.env.REWRITE_LLM_URL='http://test.invalid';process.env.REWRITE_LLM_KEY='test';
 global.fetch=async(_url,opts)=>{const prompt=JSON.parse(opts.body).messages.map(m=>m.content).join('\n');assert.doesNotMatch(prompt,/正常范围是 0\.9|目标约.*拍|字幕拍数必须落在|后续必须在合格范围内/);assert.match(prompt,/建议约13字，仅供参考，不强制/);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({text:texts[n++]})}}]}));};
 try{const beat={jp:{status:'ok',units:15},cn:{units:11.5},normalizedRatio:.981};
 const r=await load('./auto-run-llm').rewriteFive({speaker:'贝格',show:null,textJp:'どうだおまえら これがショーバイだ！',textEn:"That's how you broker an honest deal!",original:texts[0],current:texts[0],beats:beat,before:[],after:[],jpAsr:{raw:{}},failNotes:[],durationLine:durationRewritePolicy(texts[0],3.77,2.989),measure:async t=>{if(brokenMeasure)throw Error('拍数服务不可用');return{...beat,normalizedRatio:t===texts[1]?.728:.981};}});
 assert.equal(n,5);assert.equal(r.text,texts[1]);assert.equal(r.target,13);assert.equal(r.candidates[1].ratio,brokenMeasure?null:.728);
 }finally{global.fetch=originalFetch;if(oldUrl===undefined)delete process.env.REWRITE_LLM_URL;else process.env.REWRITE_LLM_URL=oldUrl;if(oldKey===undefined)delete process.env.REWRITE_LLM_KEY;else process.env.REWRITE_LLM_KEY=oldKey;}
});
