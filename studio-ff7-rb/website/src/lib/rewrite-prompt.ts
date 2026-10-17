import { NORMAL_JP_CN_RATIO, type BeatResult } from "./beats";
import { compactPerformanceBeatBand } from "./auto-run-script-policy";

export const REWRITE_COUNT = 5;
// 界面一次仍是五轮。批处理在五条都不合格时再要五条，择优最多看十个候选。
export const REWRITE_LIMIT = REWRITE_COUNT * 2;
export const REWRITE_POLICY = "literary-compact11-v2";
export const REWRITE_MIN = 0.9;
export const REWRITE_MAX = 1.1;

export type RewriteCandidate = {
  referenceTextJp?: string;
  text: string;
  beats: BeatResult;
  target: number;
  warnings: string[];
  situation: string;
  problem: string;
  plan: string;
  risk: string;
  raw: string;
  scope: string;
};

export type ShowEvidence = {
  voice_asset?: string;
  events?: { event?: string }[];
};

export type ShowLine = {
  speaker: string;
  offscreen: boolean;
  textJp: string;
  textEn: string;
  textZh: string;
  lockedZh: string | null;
};

// ratio 这里就是「比」：(日文拍 ÷ 中文拍) ÷ NORMAL_JP_CN_RATIO。1.00 为标准。
// 这条合格带只给改写反馈，不是列表上偏离 1.00 的 10%/15% 报警。
export function rewriteBand(textJp?: string) {
  return compactPerformanceBeatBand(textJp) ?? { low: REWRITE_MIN, high: REWRITE_MAX };
}

export function rewritePace(ratio: number, textJp?: string): "偏慢" | "正常" | "偏快" {
  const { low, high } = rewriteBand(textJp);
  return ratio > high + 1e-9 ? "偏慢" : ratio < low - 1e-9 ? "偏快" : "正常";
}

export function performanceKey(evidence: ShowEvidence | null | undefined): string | null {
  const asset = evidence?.voice_asset ?? "";
  const cut = asset.match(/\/Cut\/[^/]+\/([^/]+)\//);
  if (cut) return `cut:${cut[1]}`;
  const names = [...new Set((evidence?.events ?? []).map((event) => event.event).filter((name): name is string => !!name))].sort();
  return names.length ? `event:${names.join("|")}` : null;
}

export function samePerformance(current: ShowEvidence | null | undefined, other: ShowEvidence | null | undefined): boolean {
  const left = performanceKey(current);
  const right = performanceKey(other);
  if (!left || !right) return false;
  if (left.startsWith("cut:") || right.startsWith("cut:")) return left === right;
  const otherNames = new Set(right.slice("event:".length).split("|"));
  return left.slice("event:".length).split("|").some((name) => otherNames.has(name));
}

export function performanceLabel(evidence: ShowEvidence | null | undefined): string | null {
  const key = performanceKey(evidence);
  if (!key) return null;
  return key.startsWith("cut:") ? key.slice(4) : key.slice("event:".length).replaceAll("|", "、");
}

// Walk away from the current line and stop at the first line outside this
// performance. Do not skip that line to fill the quota.
export function takeUntilBoundary<T>(rows: T[], currentIndex: number, inside: (row: T) => boolean, limit = 8) {
  const before: T[] = [];
  for (let index = currentIndex - 1; index >= 0 && before.length < limit; index -= 1) {
    if (!inside(rows[index])) break;
    before.push(rows[index]);
  }
  before.reverse();
  const after: T[] = [];
  for (let index = currentIndex + 1; index < rows.length && after.length < limit; index += 1) {
    if (!inside(rows[index])) break;
    after.push(rows[index]);
  }
  return { before, after };
}

function feedback(target: number, units: number, spokenUnits?: number, matchJapanese = false, textJp?: string) {
  const { low, high } = rewriteBand(textJp);
  const ratio = units > 0 ? target / units : Infinity;
  const spokenRatio = spokenUnits != null && spokenUnits > 0 ? target / spokenUnits : ratio;
  const measured = rewritePace(spokenRatio, textJp) !== "正常" ? (spokenUnits ?? units) : units;
  const pace = rewritePace(target / measured, textJp);
  const delta = Math.max(1, Math.round(Math.abs(target - measured)));
  const action = pace === "偏慢" ? `中文偏短，放进同样的演出时间会偏慢。下一条请增加大约 ${delta} 个汉字，补全口语，不要堆语气词。`
    : pace === "偏快" ? `中文偏长，放进同样的演出时间会偏快。下一条请减少大约 ${delta} 个汉字，留下关键信息。`
    : "长度已经合格，不用向 1.00 靠拢。下一条优先优化文字：去掉重复解释、套话和赘词，让措辞简洁、自然、有韵味，保留人物口吻，不要改成书面腔。";
  const extra = Math.max(0, (spokenUnits ?? units) - units);
  const pauseHint = extra > 0 ? `本稿换行转换额外增加 ${extra} 拍。若保留这些停顿，字幕拍数必须落在 ${(target / high).toFixed(2)} 到 ${(target / low - extra).toFixed(2)} 之间才能双达标。也可以自然地调整断句：把已有逗号移到语义合适的行尾，使换行和标点共用一次停顿；或重组为不需要句中逗号的自然说法。不要叠加停顿，不要增加新意思，${matchJapanese ? "段数尽量与日文正文一致" : "行数不变"}。` : "";
  return `程序实测：中文 ${units} 拍，比 ${Number.isFinite(ratio) ? ratio.toFixed(3) : "不可计算"}；实际朗读比 ${Number.isFinite(spokenRatio) ? spokenRatio.toFixed(3) : "不可计算"}（原候选换行合成时会变成句号停顿），判定${pace}。字幕和实际朗读都要合格，可减少赘字或重复停顿，${matchJapanese ? "分段尽量与日文正文一致" : "但保持原字幕行数"}。正常范围是 ${low} 到 ${high}，含两端。${action}${pauseHint}不要复述上一条，也不要只改一个语气词。`;
}

function showLine(index: number, side: "前" | "后", line: ShowLine) {
  const locked = line.lockedZh && line.lockedZh !== line.textZh ? `\n锁定稿：${line.lockedZh}` : "";
  return `${side}${index} ${line.speaker || "未知"}${line.offscreen ? "（画外）" : ""}\n日：${line.textJp || "（无）"}\n英：${line.textEn || "（无）"}\n中：${line.textZh || "（无）"}${locked}`;
}

function clip(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 500) : "";
}

export function rewriteMessages(input: {
  attempt?: number;
  speaker: string;
  show: string | null;
  textJp: string;
  textEn: string;
  original: string;
  current: string;
  beats: BeatResult;
  before: ShowLine[];
  after: ShowLine[];
  previous: { raw: string; units: number | null; spokenUnits?: number | null }[];
  segmentationHint?: string;
  shortLine?: { min: number; max: number; target: number };
  durationLine?: { target: number; currentCharacters: number; referenceSeconds: number; candidateSeconds: number };
  slowLine?: { jpMora: number; speechSeconds: number; moraPerSecond: number; target: number; max?: number };
}) {
  // 正常句实测明显偏短后，比降为参考；独立构造提示，不能残留0.9–1.1硬目标或“越凝练越好”。
  // 字数只作推算建议，后续五稿也不再按比过滤/排序；仍须用真实TTS检验时长、校字。
  if (input.durationLine) {
    const policy = input.durationLine;
    const delta = policy.candidateSeconds - policy.referenceSeconds;
    const messages: { role: "system" | "user" | "assistant"; content: string; promptKey?: string; promptValues?: Record<string, unknown> }[] = [
      { role: "system", content: [
        "你是《最终幻想7 重生》中文配音台词编辑。本句已经出现校字通过但实际发声明显偏短，后续以实测音频时长为准，拍数比仅作参考，不设合格带，不追求接近1，也不能据此限制字数或缩短译文。",
        "原意、人物关系、称谓、否定、时态和情绪必须保留。结合日英中文及上下文，补全自然表达，可以展开同一句已有的语义，不新增事实、人物、动作或剧情，不堆无意义语气词。英文可核对中文遗漏的语义。",
        "中文偏短时优先增加有意义的正文字符；偏长时精简；已接近时长时可保持表达。建议字数只是按上一轮实测语速估算，不是上限、下限、必须凑满的目标或淘汰条件。标点、空白、引号不计正文字符；允许自然停顿，不用首尾静音或堆标点充长。",
        "不要宣称按文字就能保证精确时长，实际结果由下一轮TTS验证。使用中国大陆规范简体字。",
        "只输出JSON：situation说明演出语境，problem说明当前稿的问题，plan说明改法，text是完整中文稿，risk说明风险。禁止Markdown及JSON外解释。",
        input.segmentationHint || "",
      ].join("\n"), promptKey: "rewrite.duration.system", promptValues: {"segmentation_hint": input.segmentationHint || ""} },
      { role: "user", content: [
        `说话人：${input.speaker}；本场：${input.show || "未知"}`,
        `三语参考：日：${input.textJp}\n英：${input.textEn || "（无）"}\n原中文：${input.original}`,
        `上文：${input.before.map((line, i) => showLine(input.before.length-i, "前", line)).join("\n") || "无"}`,
        `下文：${input.after.map((line, i) => showLine(i+1, "后", line)).join("\n") || "无"}`,
        `本轮当前稿：${input.current}，正文${policy.currentCharacters}字。参考发声${policy.referenceSeconds.toFixed(3)}秒，中文${policy.candidateSeconds.toFixed(3)}秒，${delta < -0.2 ? "偏短，请增加自然表达的正文字符" : delta > 0.2 ? "偏长，请精简" : "已接近，可保持表达"}。建议约${policy.target}字，仅供参考，不强制。`,
        `当前是第${(input.attempt ?? input.previous.length)+1}个改稿候选；优先语义准确、自然和解决实际时长差，不按拍数比缩字。`,
      ].join("\n\n"), promptKey: "rewrite.duration.context", promptValues: {"speaker": input.speaker,"show": input.show || "未知","text_jp": input.textJp,"text_en": input.textEn || "（无）","original": input.original,"before_context": input.before.map((line, i) => showLine(input.before.length-i, "前", line)).join("\n") || "无","after_context": input.after.map((line, i) => showLine(i+1, "后", line)).join("\n") || "无","current": input.current,"current_characters": policy.currentCharacters,"reference_seconds": policy.referenceSeconds.toFixed(3),"candidate_seconds": policy.candidateSeconds.toFixed(3),"duration_feedback": delta < -0.2 ? "偏短，请增加自然表达的正文字符" : delta > 0.2 ? "偏长，请精简" : "已接近，可保持表达","target": policy.target,"attempt_number": (input.attempt ?? input.previous.length)+1} },
    ];
    for (const sample of input.previous) {
      messages.push({ role: "assistant", content: sample.raw });
      messages.push({ role: "user", content: "再给一条自然表达。上述候选尚未实际TTS，不把拍数比当成合格条件，字数建议也不强制。", promptKey: "rewrite.duration.followup", promptValues: {} });
    }
    return messages;
  }
  // 慢速演出使用纯摩拉对应中文字数，不混入常规拍数比目标或旧稿的拍数反馈。
  // 目标只指导模型自然增字、选稿，校字和实际音频时长仍由后续合成检查。
  if (input.slowLine) {
    const policy = input.slowLine;
    const messages: { role: "system" | "user" | "assistant"; content: string; promptKey?: string; promptValues?: Record<string, unknown> }[] = [{ role: "system", content: [
      "你是《最终幻想7 重生》中文配音修订台的台词编辑。这句日文是刻意放慢、拖长的表演句。",
      `日文正文有 ${policy.jpMora} 个摩拉（发音拍，不是日文字幕字符数），实际发声 ${policy.speechSeconds.toFixed(3)} 秒，语速 ${policy.moraPerSecond.toFixed(3)} 拍/秒，低于3拍/秒。`,
      "本句不计算、不追求拍数比，不套用普通语速的中日长度换算。",
      `请把中文正文补足到接近或等于 ${policy.target} 个汉字/朗读字符（标点、空格、引号、换行不算字数）。当前字数不足目标时，必须增加正文字符，补全自然表达，不要继续缩短译文。`,
      "这里对应的是日文发音拍与中文朗读字符，不要求一个日文字幕字符对应一个汉字，也不要求逐字翻译。目标允许为忠实原意和中文自然作小幅调整。",
      "保留核心语义、修饰限定、人物口吻和情绪。不能为省字删除重要信息；问号也可能表示悬念，不要把揭晓铺垫改成索取答案的问题。不能添加剧情、无意义语气词或用首尾静音充时长。正文已去掉拟声，不能写回合成稿。",
      policy.max == null ? "" : `正文最多${policy.max}字，这是按日文净发声每秒3.5字与日文含非引号标点字符数取较大值的上限，不必凑满。中文标点/空白不计字数；允许在自然语义边界用标点安排停顿，不要拆词、逐字堆标点。实际时长须TTS验证。`,
      "结合实际音频长度反馈调整表达，字符目标不是音频长度已合格的依据。先在problem说明为何当前稿不足以覆盖慢速演出，在plan说明怎样自然增字。",
      "只输出 JSON：situation 场景作用；problem 当前时长及措辞问题；plan 修改办法；text 新台词；risk 风险。使用规范简体字。",
      input.segmentationHint || "",
    ].join("\n"), promptKey: "rewrite.slow.system", promptValues: {"jp_mora": policy.jpMora,"speech_seconds": policy.speechSeconds.toFixed(3),"mora_per_second": policy.moraPerSecond.toFixed(3),"target": policy.target,"character_capacity_instruction": policy.max == null ? "" : `正文最多${policy.max}字，这是按日文净发声每秒3.5字与日文含非引号标点字符数取较大值的上限，不必凑满。中文标点/空白不计字数；允许在自然语义边界用标点安排停顿，不要拆词、逐字堆标点。实际时长须TTS验证。`,"segmentation_hint": input.segmentationHint || ""} }, { role: "user", content: [
      `说话人：${input.speaker}；演出：${input.show || "未识别"}`,
      `日文正文：${input.textJp}\n英文：${input.textEn}\n原中文：${input.original}\n当前稿：${input.current}`,
      ...input.before.map((line, index) => showLine(index + 1, "前", line)),
      ...input.after.map((line, index) => showLine(index + 1, "后", line)),
    ].join("\n"), promptKey: "rewrite.slow.context", promptValues: {"speaker": input.speaker,"show": input.show || "未识别","text_jp": input.textJp,"text_en": input.textEn,"original": input.original,"current": input.current,"before_context": input.before.length ? "\n" + ((input.before.map((line, index) => showLine(index + 1, "前", line))).join("\n")) : "","after_context": input.after.length ? "\n" + ((input.after.map((line, index) => showLine(index + 1, "后", line))).join("\n")) : ""} }];
    for (const sample of input.previous) {
      messages.push({ role: "assistant", content: sample.raw });
      messages.push({ role: "user", content: `继续给一条忠实、自然的说法，正文尽量接近或等于 ${policy.target} 个字符；不足时补足表达，不按拍数比反馈或排序。`, promptKey: "rewrite.slow.followup", promptValues: {"target": policy.target} });
    }
    return messages;
  }
  // 自动场景短句独立提示，不能混入普通五稿的拍数目标、偏快/偏慢反馈和比值排序。
  if (input.shortLine) {
    const { min, max } = input.shortLine;
    const messages: { role: "system" | "user" | "assistant"; content: string; promptKey?: string; promptValues?: Record<string, unknown> }[] = [{ role: "system", content: [
      "你是《最终幻想7 重生》中文配音修订台的台词编辑。当前日文正文少于八个字符，可能有长拖音。",
      "本句不计算、不追求拍数比。以程序实测的有效发声时长反馈调整中文字符数，首尾静音不能充当发声时长。",
      `中文正文必须 ${min}–${max} 个字符（标点、空格、换行不算）。请根据额外提供的实际发声时长决定怎样改写。`,
      "中文实测偏短且未达上限时，应增加当前正文的字符数、补全自然表达；若已经达到上限，优先保住核心含义，允许自然标点停顿匹配慢表达，不强制增字。实测偏长时才简化。上限是容量，不要求凑满。",
      "先在 problem 说明哪段实际发声偏短或偏长，再在 plan 说明如何相应增字或减字。不要把文件总长、首尾静音或 ASR 校字失败当作长度已合格。",
      "保留核心语义、修饰限定、人物口吻和情绪，不能为字数删掉重要信息。真正的问句需要保留；问号也可表示拖长、悬念或反问，不要机械地把铺垫揭晓改成真正索取答案的问题。不能添加剧情。",
      "字数上限只算实际朗读文字，所有标点、空格、换行均不计。鼓励在自然语义边界用逗号、省略号等标点安排停顿，以补足慢表达的时间；不能拆词、逐字插逗号或堆重复标点。波浪号不保证拖音，标点作用须实际TTS验证。",
      "正文已去掉拟声，不能把原声拟声写回新合成正文。已有合适说法可以复用，不必为了五稿而硬造同义句。",
      "只使用本场提供的上下文、三语对照；使用规范简体字。",
      "只输出 JSON：situation 场景作用；problem 当前时长及措辞问题；plan 修改办法；text 新台词；risk 风险。",
      input.segmentationHint || "",
    ].join("\n"), promptKey: "rewrite.short.system", promptValues: {"min": min,"max": max,"segmentation_hint": input.segmentationHint || ""} }, { role: "user", content: [
      `说话人：${input.speaker}；演出：${input.show || "未识别"}`,
      `日文正文：${input.textJp}\n英文：${input.textEn}\n原中文：${input.original}\n当前稿：${input.current}`,
      ...input.before.map((line, index) => showLine(index + 1, "前", line)),
      ...input.after.map((line, index) => showLine(index + 1, "后", line)),
      `这是第 ${(input.attempt ?? input.previous.length) + 1} 个候选。优先忠实原意和实测声音长度。`,
    ].join("\n"), promptKey: "rewrite.short.context", promptValues: {"speaker": input.speaker,"show": input.show || "未识别","text_jp": input.textJp,"text_en": input.textEn,"original": input.original,"current": input.current,"before_context": input.before.length ? "\n" + ((input.before.map((line, index) => showLine(index + 1, "前", line))).join("\n")) : "","after_context": input.after.length ? "\n" + ((input.after.map((line, index) => showLine(index + 1, "后", line))).join("\n")) : "","attempt_number": (input.attempt ?? input.previous.length) + 1} }];
    for (const sample of input.previous) {
      messages.push({ role: "assistant", content: sample.raw });
      messages.push({ role: "user", content: `继续给一条忠实、自然的说法；限制 ${min}–${max} 字，按实际发声时长反馈增字或减字。不按拍数评分。`, promptKey: "rewrite.short.followup", promptValues: {"min": min,"max": max} });
    }
    return messages;
  }
  const target = input.beats.jp.units! / NORMAL_JP_CN_RATIO;
  const { low, high } = rewriteBand(input.textJp);
  const lines = input.original.replace(/\\n/g, "\n").split(/\n+/).filter((line) => line.trim());
  const ratio = input.beats.cn.units > 0 ? target / input.beats.cn.units : null;
  const attempt = input.attempt ?? input.previous.length;
  const secondRound = attempt >= REWRITE_COUNT;
  const messages: { role: "system" | "user" | "assistant"; content: string; promptKey?: string; promptValues?: Record<string, unknown> }[] = [
    { role: "system", content: [
      "你是《最终幻想7 重生》中文配音修订台的台词编辑。修订对象是一场已经演出来的中文对白，要让它放进日文演出的时间里仍然像人话。",
      "只输出一个 JSON 对象，不要 Markdown，不要在 JSON 外面写说明。",
      `「比」= (日文拍 ÷ 中文拍) ÷ ${NORMAL_JP_CN_RATIO.toFixed(2)}。1.00 表示中文拍等于日文拍除以 ${NORMAL_JP_CN_RATIO.toFixed(2)}，这是参考长度，不是必须逼近的目标；${low} 到 ${high} 全部同等合格。比大于 1，中文偏短，同样的演出里会被放慢。比小于 1，中文偏长，会被加快。`,
      "拍数由程序计算，你不要自己数日文拍。句中标点计 1.5 拍，句末标点不计。换行本身不计拍，但合成时换行会读成句号。不要用无意义语气词或额外标点凑拍数，也不要把短促的喊声注水。",
      `这条工具的正常范围是 ${low} 到 ${high}。保留原意、人物关系、称谓、否定、时态、问句和情绪。不能添加事实、动作、承诺或新剧情。专名沿用原中文的写法，不要改成另一种译名。`,
      `五轮中前两轮先保义并进入 ${low}–${high}；一般从第三轮开始重点打磨表达。已有合格稿时，后续必须在合格范围内减少车轱辘话、套话、重复说明和废话，优先自然、凝练、优美且适合演员说出口的中文。不要为了更接近 1.00 加字，不要把本来简短的意思绕着说；优美不等于堆辞藻。仍未合格时先解决长度，不能牺牲原意。`,
      "每句都有日文、英文、中文。中文译得不通顺时，用英文核对意思，不要只顺着别扭的中文改。英文是同一条语音上的英文字幕，断句有时和日文、中文不一样；对不上时不要用英文改这句的情节，只在它和这句是同一意思时用来核对措辞。没有英文就写着（无），不要编造。不要按英文另起专名或称谓。",
      "必须使用中国大陆规范简体字。上下文只包含本场演出；没列出来的句子不属于这场，不要脑补它们。",
      "JSON 字段：situation 是这句在本场演出里的作用以及和前后句怎么接；problem 是当前稿的语速和措辞问题；plan 是这一条准备怎么改；text 是改写后的台词；risk 是可能改丢的地方，没有就用空字符串。text 里的换行使用 JSON 的换行转义。" + (input.segmentationHint ? "中文段数尽量与日文正文一致，不要求原中文行数。" : "行数与原中文一致。"),
      input.segmentationHint || "",
    ].join("\n"), promptKey: "rewrite.normal.system", promptValues: {"normal_ratio": NORMAL_JP_CN_RATIO.toFixed(2),"output_format_instruction": "JSON 字段：situation 是这句在本场演出里的作用以及和前后句怎么接；problem 是当前稿的语速和措辞问题；plan 是这一条准备怎么改；text 是改写后的台词；risk 是可能改丢的地方，没有就用空字符串。text 里的换行使用 JSON 的换行转义。" + (input.segmentationHint ? "中文段数尽量与日文正文一致，不要求原中文行数。" : "行数与原中文一致。"),"segmentation_hint": input.segmentationHint || "","round_notice": ""} },
  ];
  if (secondRound) {
    messages[0] = { ...messages[0], content: messages[0].content + `\n前五个候选的比都不在 ${low}–${high}。现在是补做的第二轮，每次仍然只输出一条新稿，最后会和前五条放在一起选。`, promptValues: { ...messages[0].promptValues, round_notice: `\n前五个候选的比都不在 ${low}–${high}。现在是补做的第二轮，每次仍然只输出一条新稿，最后会和前五条放在一起选。` } };
  }
  messages.push({ role: "user", content: [
    secondRound
      ? `当前是补做的第 ${attempt - REWRITE_COUNT + 1} 条。前五个候选都不在 ${low}–${high}，所以再要五个，最后只在合格稿里选。这一条先把比调进 ${low}–${high}，保住原意、人物口吻${input.segmentationHint ? "，分段尽量与日文正文一致" : "和原字幕行数"}，不要复述已经出现过的句子。`
      : `当前是第 ${attempt + 1} 轮，共五轮。${attempt >= 2 ? `本轮优先打磨已合格稿的文字表达，保持 ${low}–${high}，不为靠近 1.00 添加赘词。若仍无合格稿，先保义调好长度。` : `先保证原意和人物口吻，再将比调入 ${low}–${high}。`}`,
    `说话人：${input.speaker || "未知"}`,
    `本场演出：${input.show || "未能识别场次，因此没有附带前后文"}`,
    input.before.length ? `上文，只到本场边界：\n${input.before.map((line, index) => showLine(input.before.length - index, "前", line)).join("\n\n")}` : "上文：这场演出在这句之前没有其他演出台词。",
    `本句三语对照：\n日：${input.textJp || "（无）"}\n英：${input.textEn || "（无）"}\n原中文：\n${input.original.replace(/\\n/g, "\n")}`,
    `当前台词（要改的稿）：\n${input.current.replace(/\\n/g, "\n")}`,
    input.after.length ? `下文，只到本场边界：\n${input.after.map((line, index) => showLine(index + 1, "后", line)).join("\n\n")}` : "下文：这场演出在这句之后没有其他演出台词。",
    `程序计数：日文 ${input.beats.jp.units} 拍，当前中文 ${input.beats.cn.units} 拍，目标约 ${target.toFixed(1)} 拍，比 ${ratio == null ? "不可计算" : ratio.toFixed(3)}。${input.segmentationHint ? "分段尽量遵循日文正文提示。" : `请保持 ${Math.max(1, lines.length)} 行。`}`,
    "请先对照这句的日文、英文和中文，判断它在演出里承担什么，再说明当前稿哪里不合适，然后给出改写。",
  ].join("\n\n"), promptKey: "rewrite.normal.context", promptValues: {"attempt_instruction": secondRound
      ? `当前是补做的第 ${attempt - REWRITE_COUNT + 1} 条。前五个候选都不在 ${low}–${high}，所以再要五个，最后只在合格稿里选。这一条先把比调进 ${low}–${high}，保住原意、人物口吻${input.segmentationHint ? "，分段尽量与日文正文一致" : "和原字幕行数"}，不要复述已经出现过的句子。`
      : `当前是第 ${attempt + 1} 轮，共五轮。${attempt >= 2 ? `本轮优先打磨已合格稿的文字表达，保持 ${low}–${high}，不为靠近 1.00 添加赘词。若仍无合格稿，先保义调好长度。` : `先保证原意和人物口吻，再将比调入 ${low}–${high}。`}`,"speaker": input.speaker || "未知","show": input.show || "未能识别场次，因此没有附带前后文","before_context": input.before.length ? `上文，只到本场边界：\n${input.before.map((line, index) => showLine(input.before.length - index, "前", line)).join("\n\n")}` : "上文：这场演出在这句之前没有其他演出台词。","text_jp": input.textJp || "（无）","text_en": input.textEn || "（无）","original": input.original.replace(/\\n/g, "\n"),"current": input.current.replace(/\\n/g, "\n"),"after_context": input.after.length ? `下文，只到本场边界：\n${input.after.map((line, index) => showLine(index + 1, "后", line)).join("\n\n")}` : "下文：这场演出在这句之后没有其他演出台词。","japanese_units": input.beats.jp.units,"chinese_units": input.beats.cn.units,"target_units": target.toFixed(1),"normalized_ratio": ratio == null ? "不可计算" : ratio.toFixed(3),"layout_instruction": input.segmentationHint ? "分段尽量遵循日文正文提示。" : `请保持 ${Math.max(1, lines.length)} 行。`} });
  for (const sample of input.previous) {
    messages.push({ role: "assistant", content: sample.raw });
    messages.push({ role: "user", content: `${sample.units == null ? "本稿拍数不可用，不编造数值。" : feedback(target, sample.units, sample.spokenUnits ?? undefined, Boolean(input.segmentationHint), input.textJp)}\n请重新组织表达，再输出一个新的 JSON。保持三语对照后的原意。${input.segmentationHint || `保持 ${Math.max(1, lines.length)} 行。`}`, promptKey: "rewrite.normal.feedback", promptValues: {"beat_feedback": sample.units == null ? "本稿拍数不可用，不编造数值。" : feedback(target, sample.units, sample.spokenUnits ?? undefined, Boolean(input.segmentationHint), input.textJp),"layout_instruction": input.segmentationHint || `保持 ${Math.max(1, lines.length)} 行。`} });
  }
  return messages.map(message => message.promptKey ? { ...message, promptValues: { ...message.promptValues, beat_min: low, beat_max: high } } : message);
}

export function cleanRewrite(raw: string) {
  const text = raw.replace(/\\r\\n|\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  if (!text || !/\p{Script=Han}/u.test(text) || text.length > 1000 || /[ぁ-ゖァ-ヺ]/u.test(text) || /[{}<>\\]/.test(text)
      || /^(?:改写|台词|解释|说明|分析|字数|候选|版本)[:：]|^\d+[.、]/m.test(text)) {
    throw new Error("模型未返回可用的中文台词");
  }
  return text;
}

export function parseRewrite(raw: string) {
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型未返回 JSON");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error("模型返回的 JSON 无法解析");
  }
  const text = cleanRewrite(typeof parsed.text === "string" ? parsed.text : "");
  const draft = {
    text,
    situation: clip(parsed.situation),
    problem: clip(parsed.problem),
    plan: clip(parsed.plan),
    risk: clip(parsed.risk),
  };
  return { ...draft, raw: JSON.stringify(draft) };
}
