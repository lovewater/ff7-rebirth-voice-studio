/* eslint-disable @typescript-eslint/no-require-imports */
// 测试只替换持久化边界，保留真实模型适配、SSE、重复检测和重试逻辑。
const fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function loadLlmModule(name,metrics){
 const cache=new Map();
 function load(file){
  if(cache.has(file))return cache.get(file);
  const m=new Module(__filename);cache.set(file,m.exports);
  m.require=id=>id==='./llm-metrics'?metrics:id.startsWith('./')?load(id.slice(2)):require(id);
  m._compile(ts.transpileModule(fs.readFileSync(`${__dirname}/${file}.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,`${__dirname}/${file}.ts`);
  cache.set(file,m.exports);return m.exports;
 }
 return load(name);
}
module.exports={loadLlmModule,loadLlmChatClient:resolve=>loadLlmModule('llm-chat-client',resolve('./llm-metrics'))};
