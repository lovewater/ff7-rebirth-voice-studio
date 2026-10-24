/* eslint-disable @typescript-eslint/no-require-imports */
const {test}=require('node:test'),assert=require('node:assert/strict');
const {abnormalReplacement:replacement,shouldLeaveAbnormalPage:leave}=require('./abnormal-queue-policy.ts');
const item=(stem,reviewState='abnormal')=>({stem,reviewState});
const snapshot=()=>({first:item('A'),current:item('B'),previous:item('A'),next:item('C'),position:2,total:3});
test('仍异常时可前后翻页，新增更早条目不抢走当前页',()=>{
 const s=snapshot();assert.equal(leave('B',s),false);
 assert.equal(leave('B',{...s,first:item('0')}),false);
});
test('锁定后从实时列表移除，优先后项而非回到队首',()=>{
 const s={...snapshot(),current:item('B','locked'),position:null,total:2};
 assert.equal(leave('B',s),true);assert.equal(replacement(s),'C');
});
test('末尾移出回到最近前项，最后一条移出进入空列表',()=>{
 const s={...snapshot(),current:item('B','locked'),next:null};
 assert.equal(replacement(s),'A');
 const empty={first:null,current:item('B','locked'),next:null,previous:null,total:0,position:null};
 assert.equal(leave('B',empty),true);assert.equal(replacement(empty),null);
});
test('取消异常或旧网址都不能保留已不在列表的条目',()=>{
 assert.equal(leave('B',{...snapshot(),current:item('B','candidate')}),true);
 assert.equal(leave('B',{...snapshot(),current:null}),true);
 assert.equal(leave(null,snapshot()),true);
 assert.equal(leave(null,{...snapshot(),first:null}),false);
});
