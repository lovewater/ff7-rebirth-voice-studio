const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const cache=new Map();function load(file){if(cache.has(file))return cache.get(file).exports;const m=new Module(file);cache.set(file,m);m.require=id=>id.startsWith('./')?load(path.resolve(path.dirname(file),id+'.ts')):require(id);m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);return m.exports;}
const {isSingingLine,singingSubtitle}=load(__dirname+'/singing-original.ts');
test('任一原始语言的♪均触发，空文本和普通对白不触发',()=>{
 for(const key of ['text_jp','text_en','text_zh'])for(const note of ['♩','♪','♫','♬','🎵','🎶'])assert.equal(isSingingLine({[key]:'歌词'+note}),true);
 assert.equal(isSingingLine({}),false);assert.equal(isSingingLine({text_jp:null,text_en:'hello',text_zh:'你好'}),false);
});
test('唱歌字幕保留原字和♪，整句套一对中文括号',()=>{
 assert.equal(singingSubtitle('越想～越害怕～♪'),'（越想～越害怕～♪）');
 assert.equal(singingSubtitle('小猫咪～\n会不会～被攻击呢～♪'),'（小猫咪～\n会不会～被攻击呢～♪）');
});
test('已锁定的括号歌词幂等，兼容英文括号，空字幕不造空括号',()=>{
 for(const text of ['（越想～越害怕～♪）','(越想～越害怕～♪)','越想～越害怕～♪']){
  const once=singingSubtitle(text);assert.equal(once,'（越想～越害怕～♪）');assert.equal(singingSubtitle(once),once);
 }
 assert.equal(singingSubtitle('  '),'');
});
test('多行歌词沿用最多两行排版，不丢♪或正文',()=>{
 const out=singingSubtitle('小猫咪～\n会不会～\n被攻击呢～♪');assert.equal(out.split('\n').length,2);
 assert.equal(out.replace(/[\s\p{P}]/gu,''),'小猫咪～会不会～被攻击呢～♪'.replace(/[\s\p{P}]/gu,''));
});
