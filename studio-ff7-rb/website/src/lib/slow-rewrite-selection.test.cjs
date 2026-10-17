/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function load(name,resolve){const m=new Module(__filename);m.require=resolve;m._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/${name}.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,`${__dirname}/${name}.ts`);return m.exports;}
test('real five-draft selection uses slow character target even when ordinary beat ratios favour the shorter draft',async()=>{
 const prompt=load('rewrite-prompt',id=>id==='./beats'?require('./beats.ts'):id==='./auto-run-script-policy'?require('./auto-run-script-policy.ts'):require(id));
 const api=load('auto-run-llm',function resolve(id){
  if(id==='./llm-chat-client')return require('./llm-client-test-loader.cjs').loadLlmChatClient(resolve);
  if(id==='./rewrite-prompt')return prompt;
  if(id==='./auto-run-script-policy')return require('./auto-run-script-policy.ts');
  if(id==='./auto-run-rewrite-retry')return require('./auto-run-rewrite-retry.ts');
  if(id==='./tts-gpu')return{normalizeScript:text=>({ttsText:text})};
  if(id==='./beats')return require('./beats.ts');
  if(id==='./prompt-store')return require('./prompt-test-store.cjs');
  if(id==='./llm-metrics')return{beginLlmCall:async()=> 'test-log',recordLlmCall:async()=>{}};
  return{};
 });
 const drafts=['我们快走吧','我们大家快点离开吧','我们大家赶快离开这里吧','大家赶快离开这里吧','赶快离开吧'];
 const original=global.fetch,oldUrl=process.env.VOLCENGINE_LLM_URL,oldKey=process.env.VOLCENGINE_LLM_KEY;let n=0;
 process.env.VOLCENGINE_LLM_URL='https://example.invalid/v1';process.env.VOLCENGINE_LLM_KEY='test';
 global.fetch=async(_url,init)=>{const sent=JSON.parse(init.body);assert.match(sent.messages[0].content,/接近或等于 12/);assert.doesNotMatch(sent.messages[0].content,/目标约/);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({text:drafts[n++]})}}]}));};
 try{const result=await api.rewriteFive({speaker:'',show:null,textJp:'これはゆっくり話す台詞',textEn:'',original:'大家快走',current:'大家快走',beats:{jp:{units:12},cn:{units:4}},before:[],after:[],jpAsr:{raw:{}},failNotes:[],slowLine:{jpMora:12,target:12,moraPerSecond:2,speechSeconds:6},measure:async text=>({jp:{units:12},cn:{units:[...text].length},normalizedRatio:text===drafts[0]?1:3})});assert.equal(result.text,drafts[2]);assert.equal(result.target,12);assert.equal(n,5);}
 finally{global.fetch=original;if(oldUrl===undefined)delete process.env.VOLCENGINE_LLM_URL;else process.env.VOLCENGINE_LLM_URL=oldUrl;if(oldKey===undefined)delete process.env.VOLCENGINE_LLM_KEY;else process.env.VOLCENGINE_LLM_KEY=oldKey;}
});
