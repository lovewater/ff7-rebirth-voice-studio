/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),path=require('node:path'),ts=require('typescript');
const filename=path.join(__dirname,'auto-run-gap-policy.ts'),m=new Module(filename);m.require=id=>id==='./auto-run-rules'?require('./auto-run-rules.ts'):require(id);m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,filename);
const {validatedCloneStage:stage,allowCloneGapSplit:allow,cloneSyncsToJapanese:sync,cloneCandidateCount:count}=m.exports;
test('manual claims cannot enable cut; Grok stages require an explicit matching request and persisted model',()=>{
 assert.equal(stage(undefined,{stage:3,model:'primary',allowGapSplit:true}),null);
 for(const i of [1,2,3])assert.equal(stage(i,{stage:i,model:'grok',allowGapSplit:i===3},'grok'),i);
 for(const payload of [null,{}, {stage:2,model:'grok',allowGapSplit:false},{stage:3,model:'volcengine',allowGapSplit:true},{stage:3,model:'primary',allowGapSplit:true},{stage:3,model:'grok',allowGapSplit:false}])assert.throws(()=>stage(3,payload,'grok'));
 for(const model of [undefined,'primary','volcengine','self-hosted'])assert.throws(()=>stage(3,{stage:3,model:'grok',allowGapSplit:true},model));
 for(const i of [true,'3',0,4])assert.throws(()=>stage(i,{stage:3,model:'grok',allowGapSplit:true},'grok'));
});
test('cut only applies to the validated third performance stage and never ordinary/manual',()=>{
 for(const mode of ['scene','mixed'])assert.equal(allow(3,mode,true),true);
 for(const i of [null,1,2])assert.equal(allow(i,'scene',true),false);
 for(const mode of ['field',null,'unknown'])assert.equal(allow(3,mode,true),false);
 assert.equal(allow(3,'scene',false),false);
});

test('automatic clones have exactly two timing routes and preserve manual behavior',()=>{
 for(const mode of ['scene','mixed','field','unknown','battle','voice-bank','event',null,'']) {
  assert.equal(sync('123',mode),mode==='scene'||mode==='mixed',String(mode));
  assert.equal(sync(null,mode),mode!=='field',`manual ${mode}`);
 }
});

test('native count1/3 is independent of feedback timing and limited to verified ordinary stage1',()=>{
 for(const mode of ['field','unknown','battle','event',null])for(const feedback of [true,false])for(const requested of [1,3])assert.equal(count(requested,'run',1,mode,feedback),requested);
 for(const invalid of [0,2,4,'3',true,null])assert.throws(()=>count(invalid,'run',1,'field',true));
 for(const mode of ['scene','mixed'])for(const requested of [1,3])assert.throws(()=>count(requested,'run',1,mode,true));
 for(const requested of [1,3])assert.throws(()=>count(requested,null,null,'field',false));
 for(const stage of [null,2,3])assert.throws(()=>count(3,'run',stage,'unknown',true));
 assert.equal(count(undefined,null,null,'scene',false),3);assert.equal(count(undefined,'run',2,'scene',true),1);assert.equal(count(undefined,'run',2,'scene',false),3);
});
