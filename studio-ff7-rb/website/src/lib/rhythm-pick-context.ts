import { selectionSpeed, type CandidateSpeedMeasurements } from "./selection-speed";
import type { SeedAsrResult } from "./seed-asr";
import type { ShowLine } from "./rewrite-prompt";
import type { PromptMessage } from "./prompt-template";
import { rewriteContextChinese } from "./rewrite-context";

export const RHYTHM_PICK_METRICS_GUIDANCE = `【最终择优的数值解释与语速描述】
paceRatio=中文朗读跨度÷日文参考朗读跨度。单句跨度取首末发声，包含段内自然停顿；多段取对应各段朗读跨度之和，不含首尾及段间留白。1表示跨度相同，1.10表示中文长10%，0.90表示中文短10%。它不是音节/秒，也不是拍数“比”；接近1不代表吐字速度正常，不能据此臆测听感或压过中文表达自然度。
每条候选的netSpeech提供实测净语速rate（音节/秒）、本轮正常区间normalRange、净发声秒数和音节数，以及偏快/正常/偏慢状态。beat.normalizedRatio是已归一的拍数“比”=(日文拍÷中文拍)÷1.20；大于1中文偏短、同槽可能偏慢，小于1中文偏长、同槽可能偏快。beat.normalRange使用该句现有判断区间，beat.exempt/exemption说明是否单独豁免；豁免不等于数值正常，缺失比不能补作1。
speedDescription由程序结合两项同一候选测量给出：两项同向不合适为“速度有些过快/速度有些过慢”；仅一项不合适为“速度有些稍快/速度有些稍慢”；两项均正常为“语速正常”；两项方向相反为“语速有点奇怪”。比或净语速缺失时speedEvidenceComplete=false，只按已有证据给出稍快/稍慢或“语速数据不足”，不能当成两项都正常。
这些是供给定候选间择优的证据，不是新增硬门槛，不得选回已淘汰的候选。结合中文自然程度、前后文衔接、语速描述和实际提供的分段证据综合选择；不要只选paceRatio最接近1的候选，不臆测未提供的声线或声学听感。`;

export const RHYTHM_PICK_SYSTEM = "你在为《最终幻想7 重生》场景演出挑一条中文配音。这些候选已通过程序要求的前置检查；通过不代表净语速或拍数比都处在正常区间。\n日文提供Seed-ASR字轴，中文提供本地Qwen识别和波形起止；中文没有字轴。根据实际提供的文字、波形跨度和长度比择优，不编造中文字轴或声学听感。\n上下文连贯性也是最终择优维度：结合 context.before/after 的前后句，比较候选能否自然接话、回答问题，称谓、指代、文字语气和信息衔接是否一致。邻句中文有锁定稿时以锁定稿为主，originalTextZh 仅供核对；本句原始中文仍是 context.originalChinese，不继承本句旧锁定稿。上下文只能帮助理解，不能补造剧情、改变本句原意或放宽读音、时长、分段等已执行的门槛。只在给定候选中综合节奏与上下文连贯性择优，不为几毫秒优势牺牲接话自然度；缺少上下文时明确按现有证据判断。reason 简要说明选择的节奏依据和上下文依据（或上下文不足）。不得从文字臆测实际声线、情绪表现或其他未提供的声学听感。\n只输出 JSON：ttsId 必须是候选里的 id；reason 一句话；thinking 判断过程。" + "\n" + RHYTHM_PICK_METRICS_GUIDANCE;

export type RhythmPickInput = {
  textJp: string;
  jp: SeedAsrResult;
  context?: { speaker: string; originalChinese: string; before: ShowLine[]; after: ShowLine[] };
  candidates: ({ ttsId: string; spoken: string; asr: SeedAsrResult; paceRatio: number | null } & CandidateSpeedMeasurements)[];
};

export function rhythmPickMessages(input: RhythmPickInput): PromptMessage[] {
  const neighbor = (row: ShowLine) => ({ ...row,
    ...rewriteContextChinese(row.originalTextZh ?? row.textZh, row.lockedZh) });
  const inputJson = JSON.stringify({
    textJp: input.textJp,
    jp: { text: input.jp.text, utterances: input.jp.raw },
    context: input.context ? { ...input.context,
      before: input.context.before.map(neighbor), after: input.context.after.map(neighbor) } : null,
    candidates: input.candidates.map(row => ({ ttsId: row.ttsId, spoken: row.spoken,
      paceRatio: row.paceRatio, ...selectionSpeed(row), asr: row.asr.raw })),
  });
  return [
    { role: "system", content: RHYTHM_PICK_SYSTEM, promptKey: "rhythm-pick.system", promptValues: {} },
    { role: "user", content: inputJson, promptKey: "rhythm-pick.input", promptValues: { input_json: inputJson } },
  ];
}
