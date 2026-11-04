export type InlinePinyinHint = { character: string; pinyin: string; index: number };
/** 仅“一个汉字紧接[字母+数字]”是注音；停顿、中文备注及普通括号不在此协议内。 */
export function inlinePinyinHints(text: string): InlinePinyinHint[] {
  return [...text.matchAll(/(\p{Script=Han})\[([A-Za-z]+[0-9]+)\]/gu)]
    .map(m => ({character:m[1],pinyin:m[2].toUpperCase(),index:m.index!}));
}
export function stripInlinePinyin(text: string): string {
  return text.replace(/(\p{Script=Han})\[([A-Za-z]+[0-9]+)\]/gu,"$1");
}
/** IndexTTS 2.0的读音写法是LIU4直接替换汉字，不同时发送“陆”和“LIU4”。 */
export function inlinePinyinForTts(text: string): string {
  return text.replace(/(\p{Script=Han})\[([A-Za-z]+[0-9]+)\]/gu,(_m,_han,pinyin:string)=>pinyin.toUpperCase());
}

export function inlinePinyinReview<T extends {spoken:string;pronunciationText?:string;lexicon:{src:string;dst:string;note:string|null}[]}>(input:T) {
  const explicit=inlinePinyinHints(input.pronunciationText??input.spoken);
  return {...input,spoken:stripInlinePinyin(input.spoken),lexicon:[
    ...explicit.map(h=>({src:h.character,dst:h.pinyin,note:`本次手工注音，仅原稿位置${h.index}的这个字；注音是读音控制，不是应朗读字符。`})),
    ...input.lexicon,
  ]};
}
