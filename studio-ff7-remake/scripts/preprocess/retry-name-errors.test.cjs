const {test}=require('node:test'),assert=require('node:assert/strict');
const {scheduleNameRetries}=require('./retry-name-errors.cjs');
test('name retry scheduling changes only next_attempt_at and appends an immutable event outside checkpoints',async()=>{
 const before={stem:'failed-name',status:'retry',error:'translation-name-mismatch',attempts:5,checkpoints:{asr:{state:'recognized'}},updated_at:'unchanged',next_attempt_at:'later'};const statements=[];
 const sql=(strings,...values)=>{const text=strings.join('');statements.push({text,values});if(text.includes('SELECT j.stem'))return Promise.resolve([{stem:before.stem,before,attempts:5,next_attempt_at:'later',text_jp:'クラウド',text_en:null,translate_zh_jp:null,translate_zh_en:null,last_translation_log_id:'5988'}]);if(text.includes('UPDATE remake_preprocess_jobs'))return Promise.resolve([{next_attempt_at:'now',after:{...before,next_attempt_at:'now'}}]);return Promise.resolve([]);};sql.json=x=>x;sql.begin=fn=>fn(sql);
 const result=await scheduleNameRetries(sql);assert.equal(result.length,1);assert.equal(result[0].attempts_unchanged,5);
 const update=statements.find(x=>x.text.includes('UPDATE remake_preprocess_jobs')).text;assert.match(update,/SET next_attempt_at=now\(\) WHERE/);assert.match(update,/status='retry' AND error='translation-name-mismatch'/);assert.ok(!update.includes('checkpoints='));assert.ok(!update.includes('attempts='));
 assert.ok(statements.some(x=>x.text.includes("'retry_schedule'")));assert.ok(!statements.some(x=>x.text.includes('UPDATE line_meta')||x.text.includes('UPDATE lines')));
});
