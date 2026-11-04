import { stripInlinePinyin } from "./inline-pinyin";
/** 锁定时仅为未确认的手动朗读稿提出字幕同步。
 * 自动工作流最终成品已完成拟声恢复、排版与原文比对：覆盖为空表示沿用原文，
 * 不能再拿删过拟声的tts_text猜字幕，否则会误弹确认并把“哼/嘿嘿”等原文删掉。
 * isAutoFinal必须来自已结束工作流的selected_tts_id，或沿同句同稿audio-edit来源追溯到该成品；
 * 不能仅凭音频带auto_run_id判定，
 * 因为同一工作流的正文子音频并不等于最终组装成品。
 */
export function needsLockSubtitleConfirmation(input: {
  isAutoFinal: boolean; isJapaneseOriginal: boolean; subtitle: string | null;
  ttsText: string; original: string;
}) {
  if (input.isAutoFinal || input.isJapaneseOriginal || input.subtitle?.trim()) return false;
  const comparable = (text: string) => stripInlinePinyin(text).replace(/\\n/g, "\n").replace(/\[停顿=\d{1,4}\]/g, "").replace(/[\p{P}\s]/gu, "");
  return comparable(input.ttsText) !== comparable(input.original);
}
