const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
const m=new Module(__filename);m._compile(ts.transpileModule(fs.readFileSync(__dirname+'/pure-interjection.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
const {pureInterjectionOriginal:keep}=m.exports;
test('非语言应声、情绪、拟声及哼唱继续保留原声',()=>{
 for(const text of ['嗯','嗯？','哎呀哎呀……','呀呼～！','呃～啊～嗯……','呼哦～呼哦～呼哦～','咕波波～','咕波咕波……','咕耶——！','哼哼～♪','哈啾！哈啾！'])assert.equal(keep(text),true,text);
});
test('喂是有义呼叫，不把日文おい直接当成中文成品',()=>{
 for(const text of ['喂！','喂……','喂……喂！','啊，喂！','「喂！」\n　嗯……'])assert.equal(keep(text),false,text);
});
test('实际词句即使含语气词也不确认，保留原台词流程',()=>{
 for(const text of ['喂，过来！','嗯，对……','哎呀，糟了！','拜拜咕波～','再见咕波～','我很喜欢克劳德','嗯，我知道了','波波','123','Hey!','ああ'])assert.equal(keep(text),false,text);
});
test('空正文、纯标点和空值不能自动确认',()=>{
 for(const text of [null,undefined,'','　','……？！','♪'])assert.equal(keep(text),false);
 assert.equal(keep('「嗯！」\n　啊……'),true);
});
