/** 完整中文只有可保留原声的语气、呼声或拟声时直接使用日文原声。
 * “喂”是有词义的呼叫：日文おい不能仅凭中文字幕一个字就当作中文原声。
 * 包含“喂”的整句应进入中文制作；其余已有非语言原声规则保持。
 * 只匹配整句；含任意实际正文（例如“嗯，对”“喂，过来”）仍走正常流程。
 */
export function pureInterjectionOriginal(chinese: string | null | undefined) {
  const body = (chinese || "").normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "");
  return /^(?:[啊阿呀哇哎唉欸诶噢哦喔呜唔嗯哼哈呵嘿嘻嘘嗨呃嗬哟唷咿耶呼嚯吁哒啦咚啾吱咯嘎嗷喵汪吼咻呦嗝啧咳咔嘶呕噗]|咕波+|咕耶+|咕)+$/u.test(body);
}
