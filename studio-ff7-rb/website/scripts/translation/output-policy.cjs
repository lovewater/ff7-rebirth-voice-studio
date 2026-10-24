// 翻译只输出一个JSON译文，无思考。原文码点长度决定额度，不把上下文长度算进输出额度。
// 最小96，按32 token向上取整；64为JSON/安全余量，每个源字符再给2 token，硬上限512。
// 当前官方源文最长日文67字、英文182字符，实际最大额度分别224和448。
function translationTokenLimit(source){
 const n=[...source.trim()].length;
 return Math.min(512,Math.max(96,Math.ceil((64+2*n)/32)*32));
}
/** 严格JSON.parse整个输出：禁止从散文或Markdown围栏里提取“看起来像JSON”的片段。
 * JSON必须仅有translation字段且为非空字符串，缺字段、多字段、数组均让本任务失败重试。
 */
function parseTranslation(content,source){
 let value;
 try{value=JSON.parse(content);}catch{throw formatError();}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||
   typeof value.translation!=='string'||!value.translation.trim()||
   value.translation.length>Math.max(1000,[...source].length*10))throw formatError();
 return value.translation.trim();
}
function formatError(){const e=new Error('译文必须为仅有非空translation字符串的完整JSON对象');e.code='invalid-translation-json';return e;}
module.exports={translationTokenLimit,parseTranslation};
