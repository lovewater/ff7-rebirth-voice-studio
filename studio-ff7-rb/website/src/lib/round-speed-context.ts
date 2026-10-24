import { AsyncLocalStorage } from "node:async_hooks";
import { selectionSpeed, type CandidateSpeedMeasurements } from "./selection-speed";

type Evidence = CandidateSpeedMeasurements & { ttsId: string; script: string; paceRatio: number | null };
const context = new AsyncLocalStorage<Map<string, Evidence>>();
export function withRoundSpeedContext<T>(fn: () => T): T { return context.run(new Map(), fn); }
/** 只保存当前任务中同一音频的已有实测，不重算指标；并发句子及模型第二轮各自隔离。
 * 保留音频ID与原稿，下一稿只能参考旧稿实测，不能继承旧稿的正常/通过结论。
 */
export function rememberRoundSpeed(evidence: Evidence) {
  context.getStore()?.set(evidence.ttsId, structuredClone(evidence));
}
export const ROUND_SPEED_GUIDANCE = `【已有音频的语速软参考】
以下每项只描述所标ttsId和script的已生成正文，不是下一稿的测量；尚无音频时不预测语速。netSpeech.rate为净语速（音节/秒），normalRange引用现有正常区间；beat.normalizedRatio为“比”=(日文拍÷中文拍)÷1.20，比低表示中文偏长、容易偏快，比高表示中文偏短、容易偏慢。paceRatio为中文/日文朗读跨度，包含段内停顿，不含首尾和段间留白，不等于净语速或拍数比。
speedDescription：两项同向不合适为速度有些过快/过慢，只有一项为速度有些稍快/稍慢，两项正常为语速正常，方向相反为语速有点奇怪；缺测不当作正常，豁免不等于比值正常。
这些描述是软参考，不新增门槛或修改本轮权限；原有校字、分段、时长、硬限及已明确的联合改稿规则仍优先。校字未过的音频不能用来断定台词长短。偏快时优先考虑允许范围内精简冗余或改善意群，不靠增加停顿掩盖吐字速度；偏慢时也不机械加字。不要仅为此描述强行改稿或堆标点，自然准确且无明显改善时保留。润色仍遵守逐段等字数限制。已有标点必须如实识别，不把替换标点说成原文没有停顿。`;
export function roundSpeedMessages(ttsId?: string) {
  const rows = [...(context.getStore()?.values() ?? [])];
  const selected = ttsId ? rows.filter(row => row.ttsId === ttsId) : rows.slice(-6);
  return [{ role: "user" as const, content: ROUND_SPEED_GUIDANCE + "\n" + JSON.stringify({
    measurementScope: "candidate-emotion-free-body", status: selected.length ? "已有候选实测，逐条对应原稿" : "尚无对应音频实测",
    candidates: selected.map(row => ({ ttsId: row.ttsId, script: row.script, paceRatio: row.paceRatio, ...selectionSpeed(row) })),
  }) }];
}
