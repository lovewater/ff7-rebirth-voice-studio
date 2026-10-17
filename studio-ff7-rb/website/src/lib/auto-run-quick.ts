import type { PromptMessage } from "./prompt-template";
import { timingMarks, type Timing } from "./timing";
import { parseSpokenReview, fewestPronunciationIssues } from "./spoken-text-review";

export type QuickCandidate = { ttsId: string; spoken: string; asr: string; timing: Timing; score: number | null };

/** 快速通道只检查完整音频，不切拟声、不改稿。必须所有时间项都正常，
 * 不能只看补齐后的文件长度，把实际正文过短或结尾错位的音频放过去。
 * 复用手动Zero-shot的时间容差；无有效发声/缺测量值时必须继续完整线路。
 */
export function quickTimingPass(jp: Timing, candidate: Timing, field: boolean) {
  if (!(candidate.dur && candidate.dur > 0) || !(candidate.speech && candidate.speech > 0)) return false;
  if (Object.values(candidate).some(value => value == null || !Number.isFinite(value))) return false;
  if (field) return true; // 自然语速对白不要求与日文对时，仍需模型校字。
  return Object.values(timingMarks(jp, candidate, undefined)).every(mark => mark === "ok");
}

export const QUICK_PICK_SYSTEM = [
  "你在为《最终幻想7 重生》自动运行的快速通道校对和选择中文配音，所有候选已通过程序时间检查。",
  "输入只有原中文字幕、日英字幕、发音替换表、中文ASR及实测时间，不能声称亲耳听到音频，不能判断听不到的音色和情绪质量。",
  "逐条对照spoken与asr，忽略标点空白；按发音替换表理解实际读法。同音、近音、声调、轻声差异可容忍，记入pronunciationNotes。完全同音和替换表已解释的内容不计疑点。",
  "missing=漏字/漏句，哪怕只缺一个短字或语气词也淘汰；extra=额外字；repeated=重复朗读；unrelated=不能由近音解释的替换。每项必须指出证据，不能因意思差不多而忽略缺字，也不能因近音的字面意义不同而判无关。ASR为空不能通过。",
  "候选允许全部不合格，禁止为推荐而放宽校字。每个ttsId恰好一条review，不能遗漏、重复或添加id。",
  "在无硬伤候选中优先读音疑点少，再按文字断句自然程度及时间贴合程度排序。原稿不做改写，原字幕拟声也应完整朗读。",
  '只输出JSON：reviews=[{ttsId,pass,missing:[],extra:[],repeated:[],unrelated:[],pronunciationNotes:[],reason}]；ranking为全部候选ttsId按推荐优先级排序的数组；reason为整体选择依据。pass仅在四类硬伤全空时为true。',
].join("\n");

export function quickPickMessages(input: { original: string; textJp: string; textEn: string; lexicon: unknown; candidates: QuickCandidate[] }): PromptMessage[] {
  const inputJson = JSON.stringify(input);
  return [
    { role: "system", content: QUICK_PICK_SYSTEM, promptKey: "quick-pick.system", promptValues: {} },
    { role: "user", content: inputJson, promptKey: "quick-pick.input", promptValues: { input_json: inputJson } },
  ];
}

/** 结构校验和硬伤淘汰由代码兜底，模型排名不能选回缺字或疑点更多的候选。
 * 返回异常由调用方记录并继续完整流程，不能无声地把模型失败当成合格。
 */
export function parseQuickPick(parsed: Record<string, unknown>, candidates: QuickCandidate[]) {
  if (!Array.isArray(parsed.reviews) || parsed.reviews.length !== candidates.length) throw new Error("快速评判未覆盖全部候选");
  const seen = new Set<string>();
  const reviews = parsed.reviews.map(value => {
    if (!value || typeof value !== "object") throw new Error("快速评判格式错误");
    const row = value as Record<string, unknown>;
    const ttsId = String(row.ttsId);
    const candidate = candidates.find(item => item.ttsId === ttsId);
    if (!candidate || seen.has(ttsId)) throw new Error("快速评判候选id错误或重复");
    seen.add(ttsId);
    return { ttsId, ...parseSpokenReview(row, candidate.asr) };
  });
  if (!Array.isArray(parsed.ranking)) throw new Error("快速评判缺少排名");
  const ranking = parsed.ranking.map(String);
  if (ranking.length !== candidates.length || new Set(ranking).size !== candidates.length || ranking.some(id => !seen.has(id))) throw new Error("快速评判排名id错误");
  const best = fewestPronunciationIssues(reviews.filter(row => row.ok));
  const selected = ranking.find(id => best.some(row => row.ttsId === id)) ?? null;
  return { selected, reviews, reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 1000) : "" };
}
