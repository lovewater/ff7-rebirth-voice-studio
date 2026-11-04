/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
function compile(relative,dependencies={}) {
 const filename=path.resolve(__dirname,relative),m=new Module(filename);m.require=id=>Object.hasOwn(dependencies,id)?dependencies[id]:require(id);
 m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,filename);return m.exports;
}
const profile=compile('game-profile.ts');
const runtime=compile('project-runtime.ts',{'./game-profile':profile});
const prompts=compile('game-prompt.ts',{'./game-profile':profile});
const remake={FF7_GAME_ID:'remake',DATABASE_URL:'postgres://ff7remake@db/studio_ff7_remake'};
function withEnv(input,fn){const keys=['FF7_GAME_ID','GAME_ID','DATABASE_URL'],previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));for(const k of keys){if(input[k]===undefined)delete process.env[k];else process.env[k]=input[k];}return Promise.resolve().then(fn).finally(()=>{for(const k of keys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}});}
test('default Rebirth behavior and explicit isolated test databases remain compatible',()=>{
 assert.equal(profile.gameProfile({}).title,'FF7 Rebirth 中文配音修订台');
 assert.equal(profile.projectDatabaseUrl({}),'postgres://ff7rb@127.0.0.1:25432/studio');
 const isolated='postgres://trial@db/gap_rescue_test';assert.equal(profile.projectDatabaseUrl({DATABASE_URL:isolated}),isolated);
 assert.equal(profile.gameProfile({GAME_ID:'remake'}).id,'remake');
 for(const env of [{FF7_GAME_ID:'typo'},{FF7_GAME_ID:''},{FF7_GAME_ID:'remake',GAME_ID:'rebirth'}])assert.throws(()=>profile.gameProfile(env));
});
test('Remake refuses fallback, wrong database, privileged role and invalid URLs without leaking credentials',()=>{
 assert.equal(profile.projectDatabaseUrl(remake),remake.DATABASE_URL);
 for(const DATABASE_URL of [undefined,'not a URL','https://ff7remake@db/studio_ff7_remake','postgres://ff7remake@db/studio','postgres://ff7rb@db/studio_ff7_remake',remake.DATABASE_URL+'?database=studio',remake.DATABASE_URL+'?user=ff7rb']){
  assert.throws(()=>profile.projectDatabaseUrl({...remake,DATABASE_URL}),error=>!error.message.includes('private-test-password'));
 }
});
test('public status contains game identity and real import count, no connection details or fake readiness',()=>{
 assert.deepEqual(profile.projectReadiness(0,remake),{game:'remake',name:'FF7 Remake',title:'FF7 Remake 中文配音修订台',status:'awaiting-import',lineCount:0,extractionReady:false,sourceOriginalChineseAudio:false});
 assert.equal(profile.projectReadiness(4,remake).status,'imported');assert.equal(profile.projectReadiness(0,{}).extractionReady,true);
 assert.ok(!JSON.stringify(profile.projectReadiness(0,remake)).includes('private-test-password'));
});
test('metadata and navigation read runtime server game identity and pass it as a client prop',async()=>{
 let connections=0;const captured=[];
 const layout=compile('../app/layout.tsx',{'./globals.css':{},'next/headers':{headers:async()=>new Headers({host:'studio.local:8767'})},'next/font/google':{Geist:()=>({variable:'font-test'})},'next/server':{connection:async()=>{connections++;}},'@/lib/game-profile':profile,'./project-audio':compile('../app/project-audio.tsx'),'./nav':{Nav:props=>{captured.push(props);return React.createElement('nav',null,props.title);}}});
 for(const game of ['rebirth','remake'])await withEnv({FF7_GAME_ID:game},async()=>{
  assert.equal((await layout.generateMetadata()).title,profile.gameProfile({FF7_GAME_ID:game}).title);
  const html=renderToStaticMarkup(await layout.default({children:'content'}));assert.ok(html.includes('FF7 '+(game==='remake'?'Remake':'Rebirth')));
 });
 assert.equal(connections,4);assert.deepEqual(captured.map(x=>x.title),['FF7 Rebirth 中文配音修订台','FF7 Remake 中文配音修订台']);
 const {Nav}=compile('../app/nav.tsx',{'@/lib/cross-site-navigation':compile('cross-site-navigation.ts'),'next/navigation':{usePathname:()=>'/text'},'next/link':({children,href})=>React.createElement('a',{href},children)});
 await withEnv({FF7_GAME_ID:'rebirth'},async()=>assert.ok(renderToStaticMarkup(React.createElement(Nav,{title:'FF7 Remake 中文配音修订台',gameId:'remake',sourceOrigin:'http://studio.local:8767'})).includes('FF7 Remake')));
});
test('database validation runs before opening a client and HMR cannot reuse another database pool',async()=>{
 const previous={sql:global.sql,sqlUrl:global.sqlUrl},opened=[];
 const postgres=url=>{const result={url,serial:opened.length};opened.push(result);return result;};
 try{
  delete global.sql;delete global.sqlUrl;
  await withEnv({},async()=>{
   const a=compile('db.ts',{postgres,'./project-runtime':{projectRuntime:()=>({databaseUrl:profile.projectDatabaseUrl()})}});const b=compile('db.ts',{postgres,'./project-runtime':{projectRuntime:()=>({databaseUrl:profile.projectDatabaseUrl()})}});assert.equal(a.sql,b.sql);
  });
  await withEnv(remake,async()=>{const c=compile('db.ts',{postgres,'./project-runtime':{projectRuntime:()=>({databaseUrl:profile.projectDatabaseUrl()})}});assert.equal(c.sql.url,remake.DATABASE_URL);});
  assert.equal(opened.length,2);
  await withEnv({...remake,DATABASE_URL:'postgres://ff7rb@db/studio'},async()=>assert.throws(()=>compile('db.ts',{postgres,'./project-runtime':{projectRuntime:()=>({databaseUrl:profile.projectDatabaseUrl()})}})));
  assert.equal(opened.length,2);
 }finally{for(const k of ['sql','sqlUrl']){if(previous[k]===undefined)delete global[k];else global[k]=previous[k];}}
});
test('Remake extraction rejects before reading a request or spawning Rebirth workers',async()=>{
 for(const language of ['jp','cn']){
  const route=compile('../app/api/extract/'+language+'/route.ts',{'@/lib/game-profile':profile,'next/server':{NextResponse:{json:(body,{status}={})=>({body,status})}},'node:child_process':{spawn:()=>{throw Error('must not spawn');}}});
  await withEnv(remake,async()=>{const result=await route.POST({json:()=>{throw Error('must not read body');}});assert.equal(result.status,503);assert.match(result.body.error,/Remake/);});
 }
});
test('identical character/version IDs use distinct persistent GPU artifacts and Remake keys stay stable',()=>{
 const legacy='cld-v1';assert.equal(profile.projectGpuSpeakerKey(legacy,{}),legacy);
 const key=profile.projectGpuSpeakerKey(legacy,remake);assert.equal(key,'remake-cld-v1');assert.notEqual(key,legacy);
 assert.equal(profile.projectGpuSpeakerKey(key,remake),key);
 assert.equal(profile.projectGpuSpeakerKey('cld-draft-01ab',remake),'remake-cld-draft-01ab');
 for(const k of [key,profile.projectGpuSpeakerKey('red-v1',remake)])assert.match(k,/^[\w.\-]+$/);
});
test('project status endpoint reads its own pool count and exposes only safe public status',async()=>{
 const queries=[];const route=compile('../app/api/project/route.ts',{'@/lib/db':{sql:async parts=>{queries.push(parts.join(''));return[{count:0}];}},'@/lib/game-profile':profile,'next/server':{NextResponse:{json:x=>x}}});
 await withEnv(remake,async()=>{const result=await route.GET();assert.equal(result.game,'remake');assert.equal(result.status,'awaiting-import');assert.equal(result.lineCount,0);assert.equal(Object.hasOwn(result,'database'),false);});
 assert.equal(queries.length,1);assert.match(queries[0],/FROM lines/);
});
test('Remake requires a matching audio directory marker while legacy Rebirth remains compatible',()=>{
 const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'ff7-game-marker-')),marker=path.join(dir,'.ff7-game.json');
 try{
  assert.equal(runtime.projectRuntime({},dir).profile.id,'rebirth');
  assert.throws(()=>runtime.projectRuntime(remake,dir),/标识/);
  for(const content of ['invalid JSON','null',JSON.stringify({game_id:'rebirth',database:'studio'}),JSON.stringify({game_id:'remake',database:'studio'})]){
   fs.writeFileSync(marker,content);assert.throws(()=>runtime.projectRuntime(remake,dir),/标识/);
  }
  fs.writeFileSync(marker,JSON.stringify({game_id:'remake',database:'studio_ff7_remake'}));
  assert.equal(runtime.projectRuntime(remake,dir).databaseUrl,remake.DATABASE_URL);
  assert.throws(()=>runtime.projectRuntime({},dir),/标识/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('startup configuration failures terminate the process instead of leaving a Next server ready',()=>{
 const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'ff7-startup-')),data=path.join(dir,'data');fs.mkdirSync(data);
 const instrumentation=path.resolve(__dirname,'../instrumentation.ts');
 const script=`const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require(${JSON.stringify(require.resolve('typescript'))});const cache=new Map();function load(file){if(cache.has(file))return cache.get(file).exports;const m=new Module(file);cache.set(file,m);m.require=id=>id.startsWith('.')?load(path.resolve(path.dirname(file),id+'.ts')):require(id);m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);return m.exports;}load(${JSON.stringify(instrumentation)}).register().then(()=>console.log('READY')).catch(error=>{console.error('UNHANDLED',error.message);process.exitCode=2;});`;
 const run=env=>require('node:child_process').spawnSync(process.execPath,['-e',script],{cwd:dir,env:{...process.env,NEXT_RUNTIME:'nodejs',FF7_GAME_ID:'remake',GAME_ID:'remake',DATABASE_URL:remake.DATABASE_URL,...env},encoding:'utf8',timeout:5000});
 try{
  fs.writeFileSync(path.join(data,'.ff7-game.json'),JSON.stringify({game_id:'remake',database:'studio_ff7_remake'}));
  const badDatabase=run({DATABASE_URL:'postgres://ff7rb@db/studio'});assert.equal(badDatabase.status,1);assert.doesNotMatch(badDatabase.stdout,/READY/);assert.match(badDatabase.stderr,/站点配置验证失败/);assert.doesNotMatch(badDatabase.stderr,/private-test-password/);
  fs.writeFileSync(path.join(data,'.ff7-game.json'),JSON.stringify({game_id:'rebirth',database:'studio'}));
  const wrongAudio=run({});assert.equal(wrongAudio.status,1);assert.doesNotMatch(wrongAudio.stdout,/READY/);assert.match(wrongAudio.stderr,/音频目录标识/);
  fs.writeFileSync(path.join(data,'.ff7-game.json'),JSON.stringify({game_id:'remake',database:'studio_ff7_remake'}));
  const valid=run({});assert.equal(valid.status,0,valid.stderr);assert.match(valid.stdout,/READY/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('exact game branding is changed only in instructions; dialogue and standalone 重生 are preserved',()=>{
 const messages=[{role:'system',content:'你在为《最终幻想7 重生》修订。FF7 Rebirth / Final Fantasy VII Rebirth。不要改动台词里的重生。'},{role:'user',content:'我又重生了！FF7 Rebirth 是旧游戏名。'}];
 assert.equal(prompts.gamePromptMessages(messages,{}),messages);
 const result=prompts.gamePromptMessages(messages,remake);assert.match(result[0].content,/最终幻想VII 重制版/);assert.doesNotMatch(result[0].content,/Rebirth/);assert.match(result[0].content,/台词里的重生/);assert.equal(result[1],messages[1]);
 assert.equal(messages[0].content.includes('FF7 Rebirth'),true);assert.deepEqual(prompts.gamePromptMessages(result,remake),result);
 const noSystem=prompts.gamePromptMessages([messages[1]],remake);assert.equal(noSystem.length,2);assert.equal(noSystem[0].role,'system');
});
test('actual LLM central request and replay snapshot use the Remake instruction context without inference',async()=>{
 const previous=Object.fromEntries(['GROK_LLM_URL','GROK_LLM_KEY','GROK_LLM_MODEL'].map(k=>[k,process.env[k]])),oldFetch=global.fetch,logs=[];let wire;
 process.env.GROK_LLM_URL='https://example.invalid/v1';process.env.GROK_LLM_KEY='test-private';process.env.GROK_LLM_MODEL='grok-test';
 const client=require('./llm-client-test-loader.cjs').loadLlmModule('llm-chat-client',{beginLlmCall:async row=>{logs.push(row);return'log1';},recordLlmCall:async()=>{}});
 global.fetch=async(_url,options)=>{wire=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'{}'}}]}));};
 try{await withEnv(remake,async()=>{await client.callChatCompletion({messages:[{role:'system',content:'你是《最终幻想7 重生》的编辑。'},{role:'user',content:'重生的力量'}],task:'profile-test',attempts:1});});assert.match(wire.messages[0].content,/Remake/);assert.doesNotMatch(wire.messages[0].content,/最终幻想7 重生/);assert.equal(wire.messages[1].content,'重生的力量');assert.deepEqual(logs[0].requestBody,wire);}
 finally{global.fetch=oldFetch;for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
test('Rebirth story topics and historical experiments are not presented as Remake content',async()=>{
 const topics=compile('../app/topics/page.tsx',{'@/lib/game-profile':profile,'next/link':({children,href})=>React.createElement('a',{href},children)});
 const historical=compile('../app/test/layout.tsx',{'@/lib/game-profile':profile,'next/navigation':{notFound:()=>{throw Error('404');}}});
 await withEnv(remake,async()=>{const html=renderToStaticMarkup(React.createElement(topics.default));assert.match(html,/Remake/);assert.doesNotMatch(html,/C2210|珠诺|路法斯/);assert.throws(()=>historical.default({children:'old report'}),/404/);});
 await withEnv({},async()=>{assert.equal(historical.default({children:'old report'}),'old report');assert.match(renderToStaticMarkup(React.createElement(topics.default)),/路法斯/);});
});
test('Rebirth rejects reserved Remake identities and URI query overrides but retains legacy sandbox databases',()=>{
 for(const FF7_GAME_ID of [undefined,'rebirth'])for(const DATABASE_URL of ['postgres://ff7rb@db/studio_ff7_remake','postgres://ff7remake@db/studio','postgres://ff7rb@db/%73tudio_ff7_remake','postgres://%66f7remake@db/studio','postgres://ff7rb@db/studio?dbname=studio_ff7_remake','postgres://ff7rb@db/studio?user=ff7remake','postgres://ff7rb@db/studio?db=studio_ff7_remake','postgres://ff7rb@db/studio?DATABASE=studio_ff7_remake'])assert.throws(()=>profile.projectDatabaseUrl({FF7_GAME_ID,DATABASE_URL}));
 for(const database of ['gap_rescue_20261103','isolated_test']){const DATABASE_URL=`postgres://trial@db/${database}?application_name=sandbox`;assert.equal(profile.projectDatabaseUrl({DATABASE_URL}),DATABASE_URL);}
 for(const key of ['db','dbname','database','user','username'])assert.throws(()=>profile.projectDatabaseUrl({...remake,DATABASE_URL:remake.DATABASE_URL+`?${key}=studio`}));
});

test('cross-site navigation keeps current function pathname and origin, removes query/hash, and uses explicit server game ID',()=>{
 const helper=compile('cross-site-navigation.ts');
 assert.equal(helper.otherGameUrl('https://machine.local:8767/old?x=1#hash','/voices','remake'),'https://machine.local:8765/voices');
 assert.equal(helper.otherGameUrl('http://[::1]:8765/old?x=1#hash','/pronunciations','rebirth'),'http://[::1]:8767/pronunciations');
 for(const [gameId,label,port]of [['remake','Rebirth',8765],['rebirth','Remake',8767]]){
  for(const pathname of ['/lines','/line/a','/review/a']){
   const {Nav}=compile('../app/nav.tsx',{'@/lib/cross-site-navigation':helper,'next/navigation':{usePathname:()=>pathname},'next/link':({children,href})=>React.createElement('a',{href},children)});
   const html=renderToStaticMarkup(React.createElement(Nav,{title:'unrelated title',gameId,sourceOrigin:'http://studio.local:8767'}));
   if(pathname==='/lines'){assert.ok(html.includes('http://studio.local:'+port+'/lines'));assert.ok(html.indexOf('>'+label+'</a>')<html.indexOf('区域'));}
   else assert.ok(!html.includes('http://studio.local:'));
   if(pathname==='/review/a')assert.equal(html,'');
  }
 }
});
