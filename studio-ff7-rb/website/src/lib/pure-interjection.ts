/** 用户确认：完整中文只有语气、呼声或拟声时直接使用日文原声。
 * 不要求日文字幕存在，也不再按中日元音差异排除“喂/嗯”等短呼声。
 * 只匹配整句；含任意实际正文（例如“嗯，对”“喂，过来”）仍走正常流程。
 */
export function pureInterjectionOriginal(chinese: string | null | undefined) {
  const body = (chinese || "").normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "");
  return /^(?:[啊阿呀哇哎唉欸诶噢哦喔呜唔嗯哼哈呵嘿嘻嘘嗨喂呃嗬哟唷咿耶呼嚯吁哒啦咚啾吱咯嘎嗷喵汪吼咻呦嗝啧咳咔嘶呕噗]|咕波+|咕耶+|咕)+$/u.test(body);
}
