const {test}=require('node:test'),assert=require('node:assert/strict');
const {pureShushuOriginal}=require('./shushu-emotion.ts');
test('纯咻忽略标点空白，不限定角色，不需要ASR写对',()=>{
 for(const text of ['咻咻','咻咻咻！','咻～咻～！','“咻咻”','咻\n咻','咻\\n咻'])assert.equal(pureShushuOriginal('',text),true,text);
 for(const jp of ['シュシュ！','シュシュシュシュって','シュシュシュのシュ～！'])assert.equal(pureShushuOriginal(jp,''),true,jp);
});
test('混合普通正文或普通词出现シュ不触发机械原声',()=>{
 for(const [jp,cn]of [['シュシュッと出発する？','要咻咻地出发了吗？'],['それはひゅ～ひゅ～だな','那还真是咻～咻～呢'],['ギルガメッシュ','吉尔伽美什'],['シュート','射门'],['','噗咻～噗咻～'],['','嘿咻'],['','咻！'],['','']])assert.equal(pureShushuOriginal(jp,cn),false,cn);
});
