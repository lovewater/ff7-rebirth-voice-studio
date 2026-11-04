/* eslint-disable @typescript-eslint/no-require-imports */
// 模型单测使用初始模板快照替代数据库，不发请求、不写运行中的提示词版本。
const definitions=require('./prompt-seed.test.json'),{renderPrompt}=require('./prompt-template.ts');
exports.resolvePromptMessages=async messages=>messages.map(m=>{
 if(!m.promptKey)return{role:m.role,content:m.content};
 const row=definitions.find(p=>p.key===m.promptKey);if(!row)throw Error('测试模板不存在 '+m.promptKey);
 return{role:m.role,content:renderPrompt(row.prompt,m.promptValues||{})};
});
