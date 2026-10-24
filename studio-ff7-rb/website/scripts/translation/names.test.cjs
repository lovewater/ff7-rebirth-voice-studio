const {test}=require('node:test'),assert=require('node:assert/strict');
const {compileNames,currentEnglishNames,promptNames,validateNames}=require('./names.cjs');
const catalog=compileNames({revision:'test',entries:[
 {english:'Billy',japanese:'グリングリン',chinese:'格林葛林',english_aliases:['Billy'],matchable:true},
 {english:'Billy Bob',japanese:'ビリー・ボー',chinese:'比利·博',english_aliases:['Billy Bob'],matchable:true},
 {english:'Bill',japanese:'グリン',chinese:'格林',english_aliases:['Bill'],matchable:true},
 {english:'Sam',japanese:'サム',chinese:'山姆',english_aliases:['Sam'],matchable:true},
 {english:'Cloud',japanese:'クラウド',chinese:'克劳德',english_aliases:['Cloud'],matchable:true},
 {english:'Mr. Cuddlesworth',japanese:'シロ',chinese:'歪歪',english_aliases:['Mr. Cuddlesworth'],matchable:true},
 {english:'Man',japanese:'男',chinese:'男人',english_aliases:['Man'],matchable:false},
]});
test('只取当前英文出现的人名；没有人名返回空表',()=>{assert.deepEqual(currentEnglishNames('Billy? What are you doing?',catalog).map(x=>x.chinese),['格林葛林']);assert.deepEqual(currentEnglishNames('What are you doing?',catalog),[]);assert.deepEqual(currentEnglishNames('Man is here.',catalog),[]);});
test('最长名称与词边界防止Billy Bob误取Billy或Bill，支持所有格/大写',()=>{assert.deepEqual(currentEnglishNames("Billy Bob saw BILLY and Bill's friend Sam.",catalog).map(x=>x.chinese),['比利·博','格林葛林','格林','山姆']);assert.deepEqual(currentEnglishNames('Sample cloud Samus',catalog),[]);});
test('标点按原样匹配，不把正则通配符当名字',()=>{assert.equal(currentEnglishNames('Mr. Cuddlesworth is here.',catalog).length,1);assert.equal(currentEnglishNames('MrX Cuddlesworth is here.',catalog).length,0);});
test('模型只拿命中项的三语名字，不包含其他角色或来源大字段',()=>{assert.deepEqual(promptNames(currentEnglishNames('Sam knows.',catalog)),[{english:'Sam',japanese:'サム',chinese:'山姆'}]);});
test('源文有人名强制官方中文；日文没说名字不能因为英译表就强制增加',()=>{const names=currentEnglishNames('Sam knows.',catalog);assert.doesNotThrow(()=>validateNames('山姆知道。','Sam knows.','en',names));assert.throws(()=>validateNames('萨姆知道。','Sam knows.','en',names),{code:'translation-name-mismatch'});assert.doesNotThrow(()=>validateNames('不可能！','そんなはずはありません！','jp',names));assert.throws(()=>validateNames('比利在干什么？','グリングリンは何をしてる？','jp',currentEnglishNames('Billy?',catalog)),{code:'translation-name-mismatch'});});
