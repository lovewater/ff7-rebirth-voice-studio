const test=require('node:test'),assert=require('node:assert/strict');
const {contextFor}=require('../translate-dialogue.cjs');
const row=(text,event='scene-a',mode='scene')=>({text_jp:text,text_en:'English '+text,dialogue_mode:mode,dialogue_evidence:{events:[{event}]}});
test('同场景只给前后各两条同语言，不带中文或另一源语言',()=>{
 const rows=['a','b','c','d','e','f','g'].map(x=>row(x));
 assert.deepEqual(contextFor(rows,3,'jp'),{before:[{text:'b'},{text:'c'}],after:[{text:'e'},{text:'f'}]});
 assert.deepEqual(contextFor(rows,3,'en').before,[{text:'English b'},{text:'English c'}]);
});
test('非表演只传当前一句',()=>assert.deepEqual(contextFor([row('a'),row('b','scene-a','field'),row('c')],1,'jp'),{before:[],after:[]}));
test('演出边界不会跨越找邻句',()=>assert.deepEqual(contextFor([row('a'),row('b','other'),row('c'),row('d')],2,'jp'),{before:[],after:[{text:'d'}]}));
test('缺失证据不猜同演出',()=>{const a=row('a'),b=row('b');a.dialogue_evidence=null;assert.deepEqual(contextFor([a,b],0,'jp'),{before:[],after:[]});});
test('同语言空字幕不发送',()=>{const rows=[row('a'),row(''),row('c')];assert.deepEqual(contextFor(rows,2,'jp').before,[{text:'a'}]);});
