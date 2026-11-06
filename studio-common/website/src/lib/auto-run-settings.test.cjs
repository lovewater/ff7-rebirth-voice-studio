/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),Module=require('node:module');
function fixture(){
 let row,running=false,events=[];
 const sql=async (strings,...values)=>{
  const query=strings.join('?');
  if(query.includes("FROM line_auto_runs WHERE status='running'"))return running?[{id:1}]:[];
  if(query.includes('SELECT model,connections'))return row?[structuredClone(row)]:[];
  if(query.includes('INSERT INTO auto_run_settings(id')){row={model:values[0],connections:structuredClone(values[1]),updated_at:'now'};return [];}
  if(query.includes('INSERT INTO auto_run_settings_events')){events.push(values);return [];}
  return [];
 };
 sql.json=value=>value;sql.begin=async operation=>operation(sql);
 const m=new Module(__filename);m.require=id=>id==='./db'?{sql}:require(id);
 m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/auto-run-settings.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
 return {...m.exports,events,setRunning:value=>{running=value;}};
}
function env(){process.env.GROK_LLM_URL='http://grok.example/v1';process.env.GROK_LLM_MODEL='grok-4.7';process.env.GROK_LLM_KEY='PRIVATE-GROK';process.env.REWRITE_LLM_URL='https://glm.example/v4';process.env.REWRITE_LLM_MODEL='glm-5.3';process.env.REWRITE_LLM_KEY='PRIVATE-GLM';}
test('invalid connection settings reject unsupported models, credential URLs and malformed input',()=>{
 const f=fixture();for(const value of [null,[],{}, {model:'other'}, {model:'primary',connections:{}}, {model:'primary',connections:[{id:'primary',base:'https://user@x.test',model:'glm'}]}, {model:'primary',connections:[{id:'primary',base:'https://x.test?key=secret',model:'glm'}]}, {model:'primary',connections:[{id:'primary',base:'file:///tmp/key',model:'glm'}]}])assert.throws(()=>f.parseAutoRunSettings(value));
});
test('configuration persists per database; GET and audit never expose API keys; blank key retains existing',async()=>{
 env();const f=fixture(),other=fixture();
 const body={model:'primary',connections:[{id:'primary',base:'https://new-glm.example/v4/',model:'glm-5.3',key:'NEW-SECRET'}]};
 const saved=await f.saveAutoRunSettings(body);assert.equal(saved.model,'primary');assert.equal(saved.connections[1].base,'https://new-glm.example/v4');assert.equal(saved.connections[1].hasKey,true);
 assert.equal((await f.getAutoRunConnection('primary')).key,'NEW-SECRET');
 await f.saveAutoRunSettings({...body,connections:[{...body.connections[0],key:''}]});assert.equal((await f.getAutoRunConnection('primary')).key,'NEW-SECRET');
 assert.doesNotMatch(JSON.stringify(await f.getAutoRunSettings()),/PRIVATE-|NEW-SECRET/);assert.doesNotMatch(JSON.stringify(f.events),/PRIVATE-|NEW-SECRET/);assert.equal(f.events[0][2][0].keyChanged,true);assert.equal(f.events[1][2][0].keyChanged,false);
 assert.equal(await other.getAutoRunModel(),'grok');assert.equal((await other.getAutoRunConnection('primary')).base,'https://glm.example/v4');
});
test('unconfigured selection rejects before persistence',async()=>{
 env();delete process.env.REWRITE_LLM_KEY;const f=fixture();await assert.rejects(f.saveAutoRunSettings({model:'primary'}),/尚未配置/);assert.equal(await f.getAutoRunModel(),'grok');assert.equal(f.events.length,0);env();
});
test('each running task freezes connection across settings changes and concurrent models',async()=>{
 env();const f=fixture();await f.withAutoRunConnection('primary',async()=>{
  const before=await f.getAutoRunConnection('primary');
  await f.saveAutoRunSettings({model:'primary',connections:[{id:'primary',base:'https://changed.example',model:'glm-5.3',key:'changed-secret'}]});
  assert.deepEqual(await f.getAutoRunConnection('primary'),before);assert.ok(Object.isFrozen(before));
  const settings=await f.getAutoRunSettings();assert.equal(settings.connections[1].base,'https://changed.example');
  await f.withAutoRunConnection('grok',async()=>{assert.equal((await f.getAutoRunConnection('grok')).key,'PRIVATE-GROK');});
  assert.equal((await f.getAutoRunConnection('primary')).key,'PRIVATE-GLM');
 });assert.equal((await f.getAutoRunConnection('primary')).key,'changed-secret');
});

function routeFixture(settings){const m=new Module(__filename);m.require=id=>id==='@/lib/auto-run-settings'?settings:require(id);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/../app/api/settings/auto-run-model/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);return m.exports;}
test('settings GET/PUT API preserves validation status, hides internal failures, returns no cached credentials',async()=>{
 env();const f=fixture(),route=routeFixture(f);const response=await route.GET();assert.equal(response.headers.get('Cache-Control'),'no-store');assert.doesNotMatch(await response.text(),/PRIVATE-/);
 for(const body of [{model:'unknown'},{model:'primary',connections:[{id:'primary',base:'https://user@example.test',model:'glm-5.3'}]}]){
  const result=await route.PUT({json:async()=>body});assert.equal(result.status,400);assert.equal(await f.getAutoRunModel(),'grok');
 }
 const good=await route.PUT({json:async()=>({model:'primary'})});assert.equal(good.status,200);assert.equal((await good.json()).model,'primary');
 const broken=await route.PUT({json:async()=>{throw new SyntaxError('bad json');}});assert.equal(broken.status,400);
 const failing=routeFixture({saveAutoRunSettings:async()=>{throw Error('DB password PRIVATE-GLM');}});const failed=await failing.PUT({json:async()=>({model:'primary'})});assert.equal(failed.status,500);assert.doesNotMatch(await failed.text(),/PRIVATE-|DB password/);
});

test('running tasks block changed credentials but allow default selection and identical connection fields',async()=>{
 env();const f=fixture();f.setRunning(true);
 const error=await f.saveAutoRunSettings({model:'primary',connections:[{id:'primary',base:'https://new.example',model:'glm-5.3'}]}).catch(e=>e);assert.equal(error.status,409);assert.equal(await f.getAutoRunModel(),'grok');assert.equal(f.events.length,0);
 await f.saveAutoRunSettings({model:'primary',connections:[{id:'primary',base:'https://glm.example/v4',model:'glm-5.3',key:''}]});assert.equal(await f.getAutoRunModel(),'primary');
 const route=routeFixture(f);const result=await route.PUT({json:async()=>({model:'primary',connections:[{id:'primary',base:'https://changed.example',model:'glm-5.3'}]})});assert.equal(result.status,409);
});
