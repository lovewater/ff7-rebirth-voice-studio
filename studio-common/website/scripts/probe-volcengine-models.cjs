#!/usr/bin/env node
// 只做连接探测：复用正式适配器/数据库日志，不修改网站默认通道，不生成或修改任何台词音频。
// 配置只从环境或本机ignored Compose .env读取，不打印地址/凭据，不切换到按量API。
const fs=require('node:fs'),path=require('node:path');
const {base,load}=require('./translation/load-production.cjs');
const envFile=path.resolve(base,'../.env');
if(fs.existsSync(envFile))for(const line of fs.readFileSync(envFile,'utf8').split(/\r?\n/)){
 const m=line.match(/^(VOLCENGINE_LLM_[A-Z_]+)=(.*)$/);
 if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim().replace(/^(['"])(.*)\1$/,'$2');
}
const {sql}=load(base+'/src/lib/db.ts');
const {callChatCompletion}=load(base+'/src/lib/llm-chat-client.ts');
const models=process.argv.slice(2);
(async()=>{
 if(!models.length)throw Error('用法：node scripts/probe-volcengine-models.cjs kimi-k3 minimax-m3');
 const results=await Promise.all(models.map(async model=>{
  const start=Date.now();
  try{
   const reply=await callChatCompletion({modelId:'volcengine',volcengine:{model},task:'volcengine-connectivity-test',messages:[{role:'user',content:'连接测试。请只返回JSON：{"ok":true,"text":"连接成功"}'}],temperature:.1,maxTokens:512,attempts:1});
   const parsed=JSON.parse(reply.content);
   return {model,ok:parsed.ok===true,elapsedMs:Date.now()-start,content:reply.content,thinkingCharacters:reply.thinking.length};
  }catch(e){return{model,ok:false,elapsedMs:Date.now()-start,error:e.message};}
 }));
 console.log(JSON.stringify(results,null,2));
 if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>sql.end({timeout:3}));
