/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {conditionalLockSteps:steps}=require('./conditional-lock.ts');
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
test('short audio: only lengthen, equal increments, reach JP without overshooting',()=>{
 const s=steps(10,11);assert.equal(s.length,3);
 s.forEach((v,i)=>{assert.equal(v.direction,'lengthen');close(v.percent,10*(i+1)/3);assert.ok(v.duration<=11+1e-9);});
 close(s[2].duration,11);assert.equal(s[2].differenceMs,0);
});
test('long audio: only shorten using existing speed multiplier rule',()=>{
 const s=steps(11,10);s.forEach((v,i)=>{assert.equal(v.direction,'shorten');close(v.percent,10*(i+1)/3);assert.ok(v.duration>=10-1e-9);});
 close(s[2].duration,10);
});
test('maximum stretch or speed-up is 20%, not a forced match beyond the cap',()=>{
 close(steps(10,20)[2].ratio,1.2);assert.equal(steps(10,20)[2].differenceMs,-8000);
 close(steps(20,10)[2].ratio,1/1.2);close(steps(20,10)[2].percent,20);
});
test('missing, invalid or already aligned audio offers no scaling operations',()=>{
 for(const [a,b] of [[0,1],[1,0],[NaN,1],[1,Infinity],[1,1],[1,1.0001]])assert.deepEqual(steps(a,b),[]);
});
