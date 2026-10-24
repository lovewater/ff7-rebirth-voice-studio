const test=require('node:test'),assert=require('node:assert/strict');
const {translationTokenLimit,parseTranslation}=require('./output-policy.cjs');
test('自适应额度：短句96起，按32向上取整，上限512且不按上下文放大',()=>{
 assert.equal(translationTokenLimit('你好'),96);assert.equal(translationTokenLimit('あ'.repeat(67)),224);
 assert.equal(translationTokenLimit('e'.repeat(182)),448);assert.equal(translationTokenLimit('长'.repeat(10000)),512);
});
test('只接受完整JSON对象及唯一非空译文字段',()=>{
 assert.equal(parseTranslation(' {"translation":"  中文  "} ','source'),'中文');
 for(const t of ['不是JSON','```json\n{"translation":"中文"}\n```','说明：{"translation":"中文"}','[]','null','{}','{"translation":""}','{"translation":3}','{"translation":"中文","extra":1}'])
  assert.throws(()=>parseTranslation(t,'source'),e=>e.code==='invalid-translation-json');
});
