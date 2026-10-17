export type BeatPair = { jp: string; cn: string };
// Must match worker/mora_core.py. The recalibration procedure is commented
// above NORMAL_JP_CN_RATIO there; change this number only by that procedure.
export const BEAT_VERSION = "beats-v4-quotes-free";
export const NORMAL_JP_CN_RATIO = 1.33;

export type BeatResult = {
  version: string;
  jp: {
    status: "ok" | "short" | "missing" | "review_reading";
    characters: number;
    mora: number | null;
    punctuation: number | null;
    units: number | null;
    reading: string;
    alternateReading: string;
    alternateMora: number | null;
    unknown: string[];
  };
  // 自动流程专用纯摩拉读音；短句也可测语速，但不改变 jp.status=short 或其空比值。
  jpSpeech?: { status: "ok" | "missing" | "review_reading"; mora: number | null; reading: string };
  cn: { han: number; punctuation: number; units: number };
  // 日文拍 ÷ 中文拍，还没除以 NORMAL_JP_CN_RATIO。界面上的「比」不要读这个字段。
  ratio: number | null;
  // 「比」。(日文拍 ÷ 中文拍) ÷ NORMAL_JP_CN_RATIO。1.00 是标准长度。
  // 大于 1 中文偏短，小于 1 中文偏长。
  normalizedRatio: number | null;
  mark: "ok" | "warn" | "err" | null;
  outside: boolean;
};
