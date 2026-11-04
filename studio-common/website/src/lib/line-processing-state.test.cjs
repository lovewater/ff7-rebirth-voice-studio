/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {isLineSkipped,parseProcessingChange}=require('./line-processing-state.ts');
test('line skip is distinct from old timing exemptions and audio locks',()=>{
 assert.equal(isLineSkipped({processing_state:'skipped'}),true);
 for(const row of [null,undefined,{}, {processing_state:'active'},{skip_timing:true},{review_state:'locked'}])assert.equal(isLineSkipped(row),false);
});
test('skip and restore input validates state and bounded reasons without touching versions',()=>{
 assert.deepEqual(parseProcessingChange({state:'skipped'}),{state:'skipped',reason:'人工跳过'});
 assert.deepEqual(parseProcessingChange({state:'skipped',reason:' 缺独立日文 '}),{state:'skipped',reason:'缺独立日文'});
 assert.deepEqual(parseProcessingChange({state:'active',reason:'ignored'}),{state:'active',reason:null});
 for(const bad of [null,[],{}, {state:'locked'},{state:'skipped',reason:3},{state:'skipped',reason:'x'.repeat(501)}])assert.throws(()=>parseProcessingChange(bad));
});
