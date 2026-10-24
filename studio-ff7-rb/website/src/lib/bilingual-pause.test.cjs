const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {BILINGUAL_PAUSE_HINT}=require('./rewrite-punctuation-hint.ts');
test('正式改写/分段模板与直接润色使用同一双语软建议，追加版本可重复应用',()=>{
 const sql=fs.readFileSync(path.resolve(__dirname,'../../../db/init/087_bilingual_natural_pause.sql'),'utf8');
 assert.equal(sql.split('$policy$')[1],BILINGUAL_PAUSE_HINT);
 for(const key of ['rewrite.normal.system','rewrite.short.system','rewrite.slow.system','rewrite.slow.duration-system','rewrite.duration.system','rewrite.normal-speed.system','rewrite.measured-history.system','two-parts.repair-system','fallback-rewrite.system','rewrite.italic-ceiling.system'])assert.ok(sql.includes(`'${key}'`),key);
 assert.match(sql,/ON CONFLICT\(seed_hash\) DO NOTHING/);assert.match(sql,/SELECT DISTINCT ON\(key\)/);
 assert.match(BILINGUAL_PAUSE_HINT,/allowRewrite=false/);assert.match(BILINGUAL_PAUSE_HINT,/scriptPolicy/);
 assert.ok(!BILINGUAL_PAUSE_HINT.includes('我们是不是')); // 不把本次案例答案写成通用规则。
});
