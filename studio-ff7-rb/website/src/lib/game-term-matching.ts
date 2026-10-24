/** 去掉标点、符号与空白后匹配，跨标点/换行仍命中；不做同义词扩展或繁简转换。 */
export function compactGameTermText(text: string) { return text.replace(/[\p{P}\p{S}\s]/gu, ""); }
export function matchedGameTerms(texts: string[], terms: string[]) {
  const sources=texts.map(compactGameTermText);
  return [...new Set(terms.filter(term=>{const key=compactGameTermText(term);return key.length>0 && sources.some(text=>text.includes(key));}))];
}
export function gameTermInstruction(terms: string[]) {
  return "【游戏固定表达，必须保留】\n"+terms.map(term=>`${JSON.stringify(term)}是游戏固定表达，词组不可更改；不得换成同义词、简称、扩写成另一种说法或拆散改字。`).join("\n")+
    "\n这些词已在本句中文原稿或当前稿中出现；改稿、断句修复、时长调整及润色都必须保留原词组。可以调整周围表达及自然标点，但去掉标点后词组正文必须完整保留，不因字数、拍数或时长目标删换。仅保护列出的命中词，不为未命中的词强加术语，不新增剧情。";
}
/** 只取本句结构化中文字段；不把邻句、日英译文、历史解释里的词误作本句命中。
 * 原游戏中文由调用方另查数据库提供，确保某轮已误删术语后下一轮仍受保护。
 */
export function currentChineseTexts(messages: {role:string;content:string}[]) {
  const result:string[]=[];
  for(const message of messages){
    if(message.role!=="user")continue;
    try {
      const data=JSON.parse(message.content);
      for(const key of ["current","script","current_script","originalChinese","original_cn_tts_text","cn_tts_text","tts_text"])
        if(typeof data?.[key]==="string")result.push(data[key]);
      if(Array.isArray(data?.currentParts))for(const part of data.currentParts)if(typeof part?.text==="string")result.push(part.text);
    } catch { /* 不扫描未结构化指令或别句上下文，原稿仍由数据库保证。 */ }
  }
  return result;
}
