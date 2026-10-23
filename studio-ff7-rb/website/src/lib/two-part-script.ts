/** 只计句中停顿；引号不发声，整句末尾语气标点不产生第三段。
 * 逗号/句号/换行/省略号等连续分隔视作一处停顿；必须有且只有一处，且前后均有正文。
 */
export function splitBodyScript(script:string){
  const text=script.replace(/[「」『』“”‘’"']/gu,'').trim().replace(/[，,。.!！?？;；:：、…~～\s]+$/u,'');
  return text.split(/[，,。.!！?？;；:：、…~～\s]+/u).filter(Boolean);
}
export function hasBodyParts(script:string,requiredParts:number){return splitBodyScript(script).length===requiredParts;}
export function hasSingleBodyPause(script:string){return hasBodyParts(script,2);
}

/** 模型决定前后语义边界；程序只清理各部分的停顿标记，再用唯一逗号连接。
 * 避免模型一边声称“只有一个停顿”，一边在parts内部留下顿号、波浪号等。
 * 不改正文字符、不自行挑分界；去掉标点后是否仍与原文相同由调用方另行校验。
 */
export function scriptFromModelParts(parts:unknown,requiredParts = 2):string|null{
  if(!Array.isArray(parts)||parts.length!==requiredParts||parts.some(x=>typeof x!=='string'))return null;
  const clean=parts.map(x=>String(x).replace(/\\[rn]/gu,'').replace(/[，,。.!！?？;；:：、…~～\s]+/gu,''));
  return clean.every(Boolean)?clean.join('，'):null;
}

/** strict沿用唯一停顿；lines用换行定义语义分片并保留片内标点；relaxed允许短句自由断句。
 * 按最初正文长度固定分流，避免改稿增减一字后在线路之间来回跳。
 * 第4批是实际第4次三候选合成，不是被结构重试回退的“常规轮次”。三段暂不改变。
 */
export type BodyScriptPolicy = "strict" | "lines" | "relaxed";
export function bodyScriptPolicy(original:string,batch:number,requiredParts=2):BodyScriptPolicy {
  if(requiredParts!==2)return "strict";
  const length=[...original.replace(/[\p{P}\p{S}\p{Z}\s]/gu,"")].length;
  return length>=14 ? "lines" : batch>=4 ? "relaxed" : "strict";
}
export function scriptLines(script:string){return script.trim().split(/\r?\n/u).map(x=>x.trim()).filter(Boolean);}
export function validBodyScript(script:string,requiredParts:number,policy:BodyScriptPolicy){
  if(policy==="lines")return scriptLines(script).length===requiredParts && scriptLines(script).every(x=>/[\p{L}\p{N}]/u.test(x));
  if(policy==="relaxed")return /[\p{L}\p{N}]/u.test(script);
  return hasBodyParts(script,requiredParts);
}
/** 模型仍负责语义分界。长句按行拼接，绝不清除“行吧，”一类片内轻微停顿。 */
export function scriptFromPolicyParts(parts:unknown,requiredParts:number,policy:BodyScriptPolicy):string|null {
  if(policy==="strict")return scriptFromModelParts(parts,requiredParts);
  if(!Array.isArray(parts)||!parts.length||(policy!=="relaxed"&&parts.length!==requiredParts)||parts.some(x=>typeof x!=="string"))return null;
  const rows=parts.map(x=>String(x).replace(/\r?\n/gu," ").trim());
  return rows.every(x=>/[\p{L}\p{N}]/u.test(x))?rows.join("\n"):null;
}

/** 前三批未入围可先修断句；第三批仍失败后，给第4批准备稿时允许改字。
 * 某条实际段数正确时沿用原权限；校字/归组失败的原稿重试仍由调用方先行处理。
 */
export function allowBodyRewrite(completedBatches:number, actualParts:number[], requiredParts:number) {
  return actualParts.length > 0 && (actualParts.some(parts => parts === requiredParts) || completedBatches >= 3);
}
