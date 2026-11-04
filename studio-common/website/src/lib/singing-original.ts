import { twoLineSubtitle } from "./auto-run-subtitle";

/** 任一原始语言带音符即认定为唱歌，不限场景演出/普通对话/战斗等类型。
 * 覆盖♪及常见单/双音符与音乐emoji；纯代码分流，不尝试翻译、ASR、TTS或缩放。
 */
export function isSingingLine(line: {text_jp?: string|null; text_en?: string|null; text_zh?: string|null}) {
  return [line.text_jp,line.text_en,line.text_zh].some(text=>text!=null&&/[♩♪♫♬🎵🎶]/u.test(text));
}

/** 歌词使用现有中文字幕，只在整句外包一对中文括号；保留♪、拖音与最多两行排版。
 * 已包整句括号时不重复添加，也兼容旧版英文括号。歌词本身不交给模型改写。
 */
export function singingSubtitle(text: string) {
  let body=text.trim();
  while ((body.startsWith("（")&&body.endsWith("）"))||(body.startsWith("(")&&body.endsWith(")"))) body=body.slice(1,-1).trim();
  body=twoLineSubtitle(body);
  return body?`（${body}）`:"";
}
