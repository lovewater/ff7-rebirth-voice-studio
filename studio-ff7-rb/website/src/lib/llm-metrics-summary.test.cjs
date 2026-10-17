/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {summarizeLlmCalls}=require('./llm-metrics-summary.ts');
test('no LLM call leaves both audio fields NULL',()=>assert.deepEqual(summarizeLlmCalls([]),{tokens:null,speed:null}));
test('input/output count actual API usage and throughput is weighted by request time',()=>{
 const s=summarizeLlmCalls([{promptTokens:100,completionTokens:20,totalTokens:120,cachedTokens:50,reasoningTokens:5,elapsedMs:1000},{promptTokens:200,completionTokens:60,totalTokens:260,cachedTokens:0,reasoningTokens:10,elapsedMs:3000}]);
 assert.equal(s.tokens.input,300);assert.equal(s.tokens.output,80);assert.equal(s.tokens.total,380);assert.equal(s.tokens.reasoning,15);assert.equal(s.tokens.cached,50);assert.equal(s.tokens.calls,2);assert.equal(s.tokens.scope,'workflow');assert.equal(s.speed.elapsed_ms,4000);assert.equal(s.speed.output_tokens_per_second,20);
});
test('failed requests with unknown usage retain NULL rather than zero and do not corrupt the measured rate',()=>{
 const unknown=summarizeLlmCalls([{elapsedMs:2000}]);assert.equal(unknown.tokens.input,null);assert.equal(unknown.tokens.output,null);assert.equal(unknown.speed.output_tokens_per_second,null);assert.equal(unknown.speed.elapsed_ms,2000);
 const mixed=summarizeLlmCalls([{elapsedMs:2000},{promptTokens:0,completionTokens:10,elapsedMs:1000}],'recorded-calls');assert.equal(mixed.tokens.input,0);assert.equal(mixed.tokens.known_input_calls,1);assert.equal(mixed.tokens.scope,'recorded-calls');assert.equal(mixed.speed.elapsed_ms,3000);assert.equal(mixed.speed.measured_elapsed_ms,1000);assert.equal(mixed.speed.output_tokens_per_second,10);
});
test('invalid timing or usage cannot generate NaN, Infinity, negative tokens or unmeasured throughput',()=>{
 const s=summarizeLlmCalls([{promptTokens:-1,completionTokens:Infinity,elapsedMs:NaN},{promptTokens:5,completionTokens:8,elapsedMs:0}]);assert.equal(s.tokens.input,5);assert.equal(s.tokens.output,8);assert.equal(s.speed.output_tokens_per_second,null);assert.ok(!JSON.stringify(s).includes('NaN'));
});
