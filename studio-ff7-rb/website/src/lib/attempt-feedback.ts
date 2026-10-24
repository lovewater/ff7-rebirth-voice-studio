import { normalSpeedIgnoresBeat } from "./normal-speed-beat";
import { fastLongPressure } from "./fast-long-pressure";

export type FeedbackCheck = "text" | "parts" | "length" | "assembly" | "beat";
export type AttemptMeasurement = {
  draftId: string;
  audioId: string;
  /** null=尚未测量；净语速口径沿用speech-peak15-gap200-v1，不传文件总长。 */
  netRate: number | null;
  hardSpeed?: { enabled: boolean; pass: boolean };
  text?: { pass: boolean; missing?: string[]; extra?: string[]; repeated?: string[]; unrelated?: string[] };
  parts?: {
    required: number;
    actual: number;
    /** 来自完成缩放后的既有检查结果，不在本函数另算一遍门槛。 */
    checks: { index: number; status: "correct" | "warning" | "error"; deltaSeconds: number; originalSeconds?: number; referenceSeconds?: number }[];
    /** 与本稿逐字一致、已确认归组的各段文字；不从标点猜音频边界。 */
    texts?: string[];
    layoutPass?: boolean;
    boundaryPass?: boolean;
  };
  characters?: { count: number; min: number; max: number };
  /** 当前对时口径：段内停顿计入朗读跨度，段间留白不计；净语速独立。 */
  readingLength?: { deltaSeconds: number; pass: boolean; referenceSeconds?: number; candidateSeconds?: number; parts?: {index:number;deltaMs:number;pass:boolean}[] };
  /** 仅兼容旧记录；新流程不再发出净时长淘汰反馈。 */
  netLength?: { deltaSeconds: number; pass: boolean; referenceSeconds?: number; candidateSeconds?: number };
  length?: { deltaSeconds: number; pass: boolean };
  assembly?: { deltaSeconds?: number; pass: boolean; failure?: "cannot-fit-gaps" | "unknown" };
  beat?: { enabled: boolean; ratio: number | null; low: number; high: number };
};
export type AttemptInput = {
  draftId: string;
  script: string;
  requiredChecks: FeedbackCheck[];
  measurement?: AttemptMeasurement;
};
export type FeedbackIssue = {
  code: string;
  severity: "error" | "warning";
  reason: string;
  suggestion: string;
  part?: number;
};
export type AttemptFeedback = {
  draftId: string;
  script: string;
  audioId: string | null;
  status: "accepted" | "warning" | "rejected" | "pending" | "invalid";
  beatIgnored: boolean;
  issues: FeedbackIssue[];
  missingChecks: string[];
  suggestions: string[];
  /** 只描述同一条音频，不能拼凑不同候选的合格段来伪造一条合格音频。 */
  partResults?: {index:number;status:"correct"|"warning"|"error"|"unverified"|"unstable";deltaSeconds:number|null;reason:string;suggestedCharacters?:number}[];
};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const partName = (index: number) => `第${["", "一", "二", "三"][index] || index}段`;

/**
 * 只把“某稿某条音频的真实判定”翻译为问题+建议，不调用模型/数据库；线上调用方提供事实，独立测试复用同一逻辑。
 * draftId防止旧音频证据套给新稿。分段/长度的pass、status由现有检测提供，避免门槛分叉。
 * “字数过多/不足”仅翻译未豁免的比值方向；音频偏短不能直接推断“字数不足”。
 * 警告不是退回；缺测量不是通过；校字失败应原稿重TTS，不能擅自改写正确台词。
 */
export function calculateAttemptFeedback(input: AttemptInput): AttemptFeedback {
  const m = input.measurement;
  const result: AttemptFeedback = { draftId: input.draftId, script: input.script, audioId: m?.audioId ?? null,
    status: "pending", beatIgnored: false, issues: [], missingChecks: [], suggestions: [] };
  if (!m) { result.missingChecks = ["尚未合成验证"]; result.suggestions = ["先按本稿合成音频，再根据实测结果判断。"]; return result; }
  if (m.draftId !== input.draftId || !m.audioId) {
    result.status = "invalid";
    result.missingChecks = ["音频测量与本稿不对应"];
    result.suggestions = ["为本稿重新取得对应音频的测量，不能使用旧稿数据。"]; return result;
  }
  if (!input.requiredChecks.length) { result.missingChecks = ["未指定需要核对的项目"]; result.suggestions = ["先明确需要核对的项目，再评价本稿。"]; return result; }
  const add = (code: string, reason: string, suggestion: string, severity: "error" | "warning" = "error", part?: number) => {
    result.issues.push({ code, reason, suggestion, severity, ...(part == null ? {} : { part }) });
  };
  const missing = (name: string) => result.missingChecks.push(name);
  result.beatIgnored = normalSpeedIgnoresBeat(m.netRate) || m.beat?.enabled === false;
  if(m.parts)result.partResults=Array.from({length:m.parts.required},(_,i)=>({index:i+1,status:"unverified" as const,deltaSeconds:null,reason:"校字或分片对应尚未确认，暂不能判断本段长短。"}));

  // 校字硬伤先修合成，不把漏读产生的偏短、虚假语速和比值转成台词增减建议。
  if (input.requiredChecks.includes("text") && !m.text) missing("校字尚未完成");
  if (m.text) {
    const categories = ["missing", "extra", "repeated", "unrelated"] as const;
    const labels = { missing: "漏字", extra: "多字", repeated: "重复朗读", unrelated: "无关内容" };
    for (const key of categories) if (m.text[key]?.length) add(`text-${key}`, `音频存在${labels[key]}。`, "保持正确台词，按原稿重新生成音频。");
    if (!m.text.pass && !categories.some(key => m.text![key]?.length)) add("text-failed", "音频文字核对未通过。", "保持原稿重新生成音频，确认朗读内容完整。");
    if (result.issues.length) { result.status = "rejected"; result.suggestions = [...new Set(result.issues.map(i => i.suggestion))]; return result; }
  }

  if (input.requiredChecks.includes("text") && !m.text) {
    result.suggestions = ["先完成音频校字，再根据可靠的音频判断文字和时长问题。"]; return result;
  }
  if (m.hardSpeed?.enabled && !m.hardSpeed.pass) add("speech-too-fast", "实际说话过快。", "优先放缓发声节奏、精简冗余表达，不用长空白掩盖语速。");
  let partsValid = false;
  if (input.requiredChecks.includes("parts") && !m.parts) missing("分段尚未完成");
  if (m.parts) {
    const p = m.parts;
    result.partResults=Array.from({length:p.required},(_,i)=>({index:i+1,status:"unverified" as const,deltaSeconds:null,reason:"尚未确认与目标分片的对应，不能判断本段长短。"}));
    if (p.actual !== p.required) {
      add("parts-count", `音频需要${p.required}段，实际为${p.actual}段。`, `按${p.required}行对应${p.required}个音频分片整理台词，优先调整自然断句。`);
    } else if (p.boundaryPass===false) {
      add("parts-boundary","音频段数正确，但切口与台词对应行不一致。","保持完整台词，按目标行重新断句合成；不能按错位分片的时长增减字。");
    } else {
      partsValid = true;
      for (let index = 1; index <= p.required; index++) {
        const part = p.checks.find(x => x.index === index);
        if (!part || !finite(part.deltaSeconds)) { missing(`${partName(index)}时长尚未测量`); continue; }
        // 仅用同一候选、核字一致且边界确认的中文段估算，不套用JP拍数或整句含空白总长。
        const compact = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, "");
        const texts = p.texts;
        const text = texts?.length === p.required && compact(texts.join("")) === compact(input.script) ? compact(texts[index-1]) : "";
        // 数字/英文的字面字符数不等于朗读音节数，缺少可靠读法时不给字数建议。
        const suggestedCharacters = part.status !== "correct" && /^\p{Script=Han}+$/u.test(text)
          && finite(part.originalSeconds) && part.originalSeconds > 0
          && finite(part.referenceSeconds) && part.referenceSeconds > 0
          ? Math.max(1, Math.round([...text].length * part.referenceSeconds / part.originalSeconds)) : undefined;
        result.partResults[index-1]={index,status:part.status,deltaSeconds:part.deltaSeconds,
          reason:part.status==="correct"?"时长正确，保持当前节奏。":`${part.status==="warning"?"警告":"错误"}：音频${part.deltaSeconds<0?"偏短":"偏长"}。`,
          ...(suggestedCharacters === undefined ? {} : { suggestedCharacters })};
        if (part.status !== "correct") {
          const short = part.deltaSeconds < 0;
          if (part.deltaSeconds === 0) { missing(`${partName(index)}时长状态与测量不一致`); continue; }
          add(short ? "part-short" : "part-long", `${partName(index)}音频${short ? "偏短" : "偏长"}。`,
            short ? `调整${partName(index)}的自然停顿，必要时适当增加该段文字。` : `让${partName(index)}表达更紧凑，必要时精简该段文字。`, part.status === "warning" ? "warning" : "error", index);
        }
      }
      if (p.layoutPass === false) add("parts-layout", "分段音频无法合理组装。", "调整过长分片的表达和停顿，为段间留出必要空白。");
    }
  }
  // 片数不对时不能假称第N段对应准确；只提供结构建议，避免按错位片段增删文字。
  const trustworthyParts = !m.parts || partsValid;
  const pressure = fastLongPressure({...m,evidenceVerified:(!input.requiredChecks.includes("parts")||partsValid)});
  if (pressure.triggered) add("fast-and-long",
    `净语速${pressure.rate!.toFixed(3)}音节/秒高于正常区间${pressure.normalLow}–${pressure.normalHigh}，且拍数比${pressure.normalizedRatio!.toFixed(3)}低于${pressure.beatLow}，中文偏长。`,
    "优先精简冗余表达、缩短朗读稿，保留原意和自然停顿；不能只加静音或堆标点稀释语速，新稿须重新TTS核字和实测。");
  if (input.requiredChecks.includes("length") && !m.length) missing("音频长度尚未测量");
  if (trustworthyParts && m.length && !m.length.pass) {
    if (!finite(m.length.deltaSeconds) || m.length.deltaSeconds === 0) missing("音频长度缺少有效误差");
    else if (!result.issues.some(i => i.code === "part-short" || i.code === "part-long")) {
      const short = m.length.deltaSeconds < 0;
      add(short ? "audio-short" : "audio-long", `整体音频${short ? "偏短" : "偏长"}。`, short ? "优先调整自然断句和停顿，必要时适当增加文字。" : "优先让表达和停顿更紧凑，必要时精简文字。");
    }
  }
  if (input.requiredChecks.includes("assembly") && !m.assembly) missing("最终组装尚未验证");
  if (m.assembly && !m.assembly.pass) {
    if (m.assembly.failure === "cannot-fit-gaps") add("assembly-gap", "最终音频无法保留必要的段间空白。", "精简过长分片或减少不必要停顿，保留已合格部分。");
    else if (finite(m.assembly.deltaSeconds) && m.assembly.deltaSeconds !== 0) add("assembly-length", `最终音频${m.assembly.deltaSeconds < 0 ? "偏短" : "偏长"}。`, "优先调整首尾和段间留白，使最终长度合适；不要无依据改动已合格分片。");
    else add("assembly-unknown", "最终音频组装未通过，原因尚不明确。", "先检查组装过程并补充失败原因，不据此猜测应增字还是减字。");
  }

  if (input.requiredChecks.includes("beat") && !m.beat) missing("字数容量尚未测量");
  if (m.beat?.enabled && !result.beatIgnored) {
    if (!finite(m.netRate) || m.netRate <= 0) missing("净语速尚未测量，暂不能确定是否忽略字数容量");
    else if (!finite(m.beat.low) || !finite(m.beat.high) || m.beat.low <= 0 || m.beat.low > m.beat.high) missing("字数容量的判断范围无效");
    else if (!finite(m.beat.ratio) || m.beat.ratio <= 0) missing("字数容量尚未测量");
    else if (m.beat.ratio < m.beat.low) add("text-too-many", "字数过多。", "精简冗余表达，保留中心意思和自然停顿。");
    else if (m.beat.ratio > m.beat.high) add("text-too-few", "字数不足。", "适当增加自然、有意义的表达，保留中心意思。");
  }
  if (m.characters) {
    if (m.characters.count < m.characters.min) add("character-too-few", "字数不足。", "在允许范围内补全自然表达，保留中心意思。");
    if (m.characters.count > m.characters.max) add("character-too-many", "字数过多。", "精简冗余表达，保留中心意思和自然停顿。");
  }
  if (trustworthyParts && m.readingLength && !m.readingLength.pass) {
    const failedParts=m.readingLength.parts?.filter(part=>!part.pass)??[];
    if(failedParts.length>1 || (m.parts && failedParts.length)) {
      for(const part of failedParts){
        if(!finite(part.deltaMs)||part.deltaMs===0){missing(`${partName(part.index)}朗读跨度缺少有效误差`);continue;}
        if(result.issues.some(issue=>issue.part===part.index && ["part-short","part-long"].includes(issue.code)))continue;
        add(part.deltaMs<0?"part-short":"part-long",`${partName(part.index)}朗读跨度${part.deltaMs<0?"偏短":"偏长"}（包含段内自然停顿）。`,
          `只调整${partName(part.index)}的自然节奏，必要时调整该段表达；其他可用分段保持，段间空白不能抵消该段误差。`,"error",part.index);
      }
    } else if (!finite(m.readingLength.deltaSeconds) || m.readingLength.deltaSeconds === 0) missing("正文朗读跨度缺少有效误差");
    else if (!result.issues.some(issue => issue.code === "part-short" || issue.code === "part-long")) {
      const short = m.readingLength.deltaSeconds < 0;
      add(short ? "reading-audio-short" : "reading-audio-long", `正文朗读跨度${short ? "偏短" : "偏长"}（包含段内自然停顿）。`,
        short ? "先检查自然停顿、对齐和允许范围内的拉伸；仍无法对齐时再适当增加有意义的表达，段间留白不能补足段内时长。" : "先检查自然节奏和允许范围内的拉伸，仍无法对齐时再精简冗余表达。");
    }
  }
  if (m.netLength && !m.netLength.pass) {
    if (!finite(m.netLength.deltaSeconds) || m.netLength.deltaSeconds === 0) missing("正文净发声时长缺少有效误差");
    else {
      const short = m.netLength.deltaSeconds < 0;
      add(short ? "net-audio-short" : "net-audio-long", `正文净发声时间${short ? "偏短" : "偏长"}。`, short ? "优先调整自然发声节奏，必要时适当增加表达；不靠长空白补时长。" : "收紧自然发声节奏，必要时精简冗余表达。");
    }
  }
  result.suggestions = issueSuggestions(result.issues);
  const tooMany=result.issues.some(i=>["text-too-many","character-too-many","fast-and-long"].includes(i.code));
  const tooFew=result.issues.some(i=>["text-too-few","character-too-few"].includes(i.code));
  if (!trustworthyParts) result.suggestions = result.issues.filter(issue => ["parts-count","parts-boundary"].includes(issue.code)).map(issue => issue.suggestion);
  const affected = new Set(result.issues.flatMap(i => i.part == null ? [] : [i.part]));
  if (partsValid && affected.size && !tooMany && !tooFew && !result.issues.some(i => ["parts-layout", "assembly-gap"].includes(i.code))) {
    const stable = m.parts!.checks.filter(p => p.status === "correct" && !affected.has(p.index)).map(p => partName(p.index));
    if (stable.length) result.suggestions.push(`${stable.join("、")}保持。`);
  }
  result.status = result.issues.some(i => i.severity === "error") ? "rejected" : result.missingChecks.length ? "pending" : result.issues.length ? "warning" : "accepted";
  return result;
}

/** 单条及汇总共用行动裁决，避免同一问题在两处给出相反方向。 */
function issueSuggestions(issues: FeedbackIssue[]) {
  // 同一候选同时收到“减字”和“补时长”时合并建议，不把互相冲突的指令丢给模型。
  const tooMany = issues.some(i => ["text-too-many", "character-too-many", "fast-and-long"].includes(i.code));
  const tooFew = issues.some(i => ["text-too-few", "character-too-few"].includes(i.code));
  const short = issues.some(i => i.code === "part-short" || i.code === "audio-short" || (i.code === "net-audio-short" || i.code === "reading-audio-short"));
  const long = issues.some(i => i.code === "part-long" || i.code === "audio-long" || (i.code === "net-audio-long" || i.code === "reading-audio-long"));
  const tooFast = issues.some(i => i.code === "speech-too-fast");
  // 一个方向约束整个稿时，逐段建议不能再反向加字/删字；不同分段各自长短不算互相冲突。
  let suggestions = [...new Set(issues.map(issue => {
    if ((tooMany || tooFast) && ["part-short", "audio-short", "net-audio-short", "reading-audio-short"].includes(issue.code))
      return `${issue.part == null ? "偏短部分" : partName(issue.part)}优先调整自然停顿和发声节奏，避免继续增加文字。`;
    if (tooFew && ["part-long", "audio-long", "net-audio-long", "reading-audio-long"].includes(issue.code))
      return `${issue.part == null ? "偏长部分" : partName(issue.part)}优先减少不必要停顿、收紧节奏，不因时长问题继续删字。`;
    return issue.suggestion;
  }))];
  if (tooMany && short) suggestions.unshift("字数与时长要求存在冲突：精简冗余，同时用自然停顿补足偏短部分，不恢复失败长稿。");
  if (tooFew && long) suggestions.unshift("字数与时长要求存在冲突：补全表达，同时收紧偏长部分的节奏，不能简单反复增字、删字。");
  if (tooFew && tooFast) suggestions = ["字数容量与实际语速的要求冲突。先保持中心意思，调整发声节奏并重试，不同时要求增字和减字。"]; 
  return suggestions;
}

/** 同稿汇总按项目、分段分别裁决，问题集合不同不等于行动方向冲突。
 * 以最接近要求的一条可靠音频为基准，不拼接不同音频的“好段”。共同问题自然保留。
 * 只将同一项目确实相反的长短方向改为局部重试，不能抹掉其他段/全文容量的稳定问题。
 * pending不覆盖已确认的失败；校字硬伤、切口错位不作为可靠语义/分段长度依据。
 */
export function summarizeDraftFeedback(attempts: AttemptFeedback[]): (AttemptFeedback & { audioIds: string[] })[] {
  const groups = new Map<string, AttemptFeedback[]>();
  for (const attempt of attempts) {
    const group = groups.get(attempt.draftId) ?? [];
    if (group.some(item => item.script !== attempt.script)) throw Error("同一稿件ID出现不同台词，禁止合并音频证据");
    group.push(attempt); groups.set(attempt.draftId, group);
  }
  return [...groups.values()].map(group => {
    const audioIds = [...new Set(group.flatMap(a => a.audioId ? [a.audioId] : []))];
    const usable = group.find(a => a.status === "accepted") ?? group.find(a => a.status === "warning");
    if (usable) return { ...usable, audioIds };
    const rejected = group.filter(a => a.status === "rejected");
    const reliable = rejected.filter(a => !a.issues.some(i => i.code.startsWith("text-" ) && !["text-too-many", "text-too-few"].includes(i.code)));
    const structural=reliable.filter(a=>!a.issues.some(i=>["parts-count","parts-boundary"].includes(i.code)));
    const pool = structural.length?structural:reliable.length ? reliable : rejected;
    if (!pool.length) return { ...(group.find(a=>a.status==="pending")??group[0]), audioIds };
    const score=(a:AttemptFeedback)=>a.issues.filter(i=>i.severity==="error").length*100+a.issues.filter(i=>i.severity==="warning").length+(a.partResults??[]).reduce((n,p)=>n+Math.min(1,Math.abs(p.deltaSeconds??0)),0);
    const best=[...pool].sort((a,b)=>score(a)-score(b))[0];
    const direction=(i:FeedbackIssue):[string,string]|null=>{
      if(i.code==="part-short"||i.code==="part-long")return [`part:${i.part}`,i.code];
      for(const [scope,short,long] of [["beat","text-too-few","text-too-many"],["characters","character-too-few","character-too-many"],["length","audio-short","audio-long"],["net","net-audio-short","net-audio-long"],["reading","reading-audio-short","reading-audio-long"]])if(i.code===short||i.code===long)return [scope,i.code];
      return null;
    };
    const directions=new Map<string,Set<string>>();
    for(const a of pool)for(const issue of a.issues){const d=direction(issue);if(d){const values=directions.get(d[0])??new Set<string>();values.add(d[1]);directions.set(d[0],values);}}
    const issues=best.issues.map(issue=>{
      const d=direction(issue);if(!d||directions.get(d[0])!.size<2)return {...issue};
      const label=issue.part==null?"本项目":partName(issue.part);
      return {code:"generation-unstable",part:issue.part,severity:"error" as const,reason:`${label}不同次合成存在相反方向的问题。`,suggestion:`${label}先保持台词重试、核对发声节奏，不同时增字减字；其他已确认问题仍按各自建议处理。`};
    });
    const partResults=best.partResults?.map(p=>issues.some(i=>i.code==="generation-unstable"&&i.part===p.index)?{...p,status:"unstable" as const,reason:"同一段不同次合成有长有短，先核对节奏；不能与其他段合并成全稿不改。"}:{...p});
    const suggestions=issueSuggestions(issues);
    if(issues.some(i=>["parts-count","parts-boundary"].includes(i.code)))return {...best,audioIds,issues,partResults,suggestions:issues.filter(i=>["parts-count","parts-boundary"].includes(i.code)).map(i=>i.suggestion)};
    return {...best,audioIds,issues,partResults,suggestions};
  });
}

/** 历史层再检查一次：不同稿件的“加/减字”不能串成无休止的回退循环。
 * 保留逐稿事实；总建议只给共同可行方向，不把某稿测量继承给另一稿。
 */
export function calculateHistoryGuidance(attempts: AttemptFeedback[]) {
  const drafts = summarizeDraftFeedback(attempts);
  const accepted = drafts.filter(a => a.status === "accepted");
  if (accepted.length) return { conflict: false, canKeep: accepted.map(a => a.draftId), suggestions: ["已有通过本轮检查的可用稿，保留该结果，不因其他失败稿的表现重新改写它。"] };
  const warnings = drafts.filter(a => a.status === "warning");
  if (warnings.length) return { conflict: false, canKeep: warnings.map(a => a.draftId), suggestions: ["已有仅含警告的可用稿，必须保留。若继续改善，只针对它剩余的问题，不能被失败旧稿替换。"] };
  const has = (codes: string[]) => drafts.some(d => d.issues.some(i => codes.includes(i.code)));
  if (has(["text-too-many"]) && has(["part-short", "audio-short", "reading-audio-short"])) return { conflict: true, canKeep: [] as string[], suggestions: ["历史尝试中同时出现字数过多和音频偏短。不要在失败长稿和短稿之间来回切换；优先通过自然断句、停顿和必要的小幅措辞调整寻找折中，不能只按最后一条退回原因改稿。"] };
  if (has(["text-too-few"]) && has(["part-long", "audio-long", "reading-audio-long"])) return { conflict: true, canKeep: [] as string[], suggestions: ["历史尝试中同时出现字数不足和音频偏长。补全表达时优先收紧不必要停顿，不简单恢复冗长旧稿，也不再次删成信息不足的短稿。"] };
  return { conflict: false, canKeep: [] as string[], suggestions: ["结合各稿自己的问题寻找改进；不能把不同稿件的测量或结论混用。"] };
}

/** 跨稿冲突出现后也改写逐条建议，不能正文仍喊加字、末尾才补一句“找折中”。
 * 退回事实原样保留；仅合并下一轮的行动方向。小幅措辞调整仍允许，禁止的是反复回到失败两端。
 */
export function resolveHistorySuggestions(attempts: AttemptFeedback[]) {
  const drafts = summarizeDraftFeedback(attempts);
  const guidance = calculateHistoryGuidance(drafts);
  if (!guidance.conflict) return { drafts, guidance };
  const hasTooMany = drafts.some(d => d.issues.some(i => ["text-too-many", "character-too-many"].includes(i.code)));
  return { guidance, drafts: drafts.map(d => {
    const short = d.issues.some(i => ["part-short", "audio-short", "reading-audio-short"].includes(i.code));
    const long = d.issues.some(i => ["part-long", "audio-long", "reading-audio-long"].includes(i.code));
    const many = d.issues.some(i => ["text-too-many", "character-too-many"].includes(i.code));
    const few = d.issues.some(i => ["text-too-few", "character-too-few"].includes(i.code));
    if (hasTooMany && short && !many) return { ...d, suggestions: ["保留精简表达，优先调整偏短部分的自然断句和停顿；必要时小幅调整措辞，不恢复字数过多的失败长稿。"] };
    if (hasTooMany && many && !short) return { ...d, suggestions: ["精简冗余表达并保留自然停顿，不删回已证实发声不足的失败短稿。"] };
    if (!hasTooMany && long && !few) return { ...d, suggestions: ["优先收紧不必要的停顿，保留关键表达，不再次缩成字数不足的失败短稿。"] };
    if (!hasTooMany && few && !long) return { ...d, suggestions: ["补全表达并采用紧凑自然的措辞和停顿，不恢复音频明显偏长的失败旧稿。"] };
    return d;
  }) };
}

/** 供用户审核的独立prompt片段。内部保留ID用于追溯，给模型的文字不展示计算细节。 */
export function renderAttemptFeedback(attempts: AttemptFeedback[]) {
  const resolved = resolveHistorySuggestions(attempts);
  const lines = ["【已有的尝试和出现的问题】", "第一段、第二段、第三段分别指台词对应行的音频分片，不按行内标点重新划分。同稿以最接近要求的同一条音频为基准，不拼凑不同候选的合格段；某段重试不代表全稿不改。"];
  resolved.drafts.forEach((attempt, index) => {
    lines.push("", `${index + 1}. 台词：`, attempt.script);
    if(attempt.partResults?.length){
      lines.push("逐段检查：",...attempt.partResults.map(p=>`${partName(p.index)}：${p.reason}${p.suggestedCharacters !== undefined && (p.status === "warning" || p.status === "error") ? ` 本段建议约${p.suggestedCharacters}字（按本稿实测语速估算，仅供改稿参考；遵守本轮改字权限，新稿须重新合成验收）。` : ""}`));
    }
    if (attempt.status === "accepted") lines.push("结果：已有满足本轮检查要求的可用音频。");
    else if (attempt.status === "warning") lines.push(`结果：已有可用音频，仍可改善：${attempt.issues.map(i => i.reason).join("")}`);
    else if (attempt.status === "pending" || attempt.status === "invalid") lines.push(`待验证：${attempt.missingChecks.join("；")}。`);
    else lines.push(`退回原因：${attempt.issues.map(i => i.reason).join("")}`);
    if (attempt.status === "rejected" && attempt.missingChecks.length) lines.push(`另有待验证项目：${attempt.missingChecks.join("；")}。`);
    if (attempt.suggestions.length) lines.push(`建议改进：${attempt.suggestions.join("")}`);
  });
  const history = resolved.guidance;
  lines.push("", "【综合改进方向】", ...history.suggestions);
  lines.push("", "历史问题只属于对应稿件和音频。针对实际问题改进；要求原稿重试时不擅自改字。新稿必须重新合成验证，最初的日文、英文及中文字幕始终是中心意思。");
  return lines.join("\n");
}
