import { NATURAL_PUNCTUATION_HINT, BILINGUAL_PAUSE_HINT } from "./rewrite-punctuation-hint";
import { callChatCompletion, type ChatMessage } from "./llm-chat-client";
import { spokenCharacters } from "./auto-run-script-policy";
import { scriptLines, splitBodyScript, scriptFromPolicyParts, validBodyScript, type BodyScriptPolicy } from "./two-part-script";

export function acceptedScriptParts(script: string, requiredParts: number, policy: BodyScriptPolicy): string[] | null {
  const parts = requiredParts === 1 ? [script.trim()] : policy === "strict" ? splitBodyScript(script) : scriptLines(script);
  return parts.length === requiredParts && parts.every(p => spokenCharacters(p) > 0) ? parts : null;
}
const hanCount = (text: string) => [...text.matchAll(/\p{Script=Han}/gu)].length;

export function validatePolishParts(original: string[], proposed: unknown) {
  if (!Array.isArray(proposed) || proposed.length !== original.length || proposed.some(p => typeof p !== "string" || !p.trim()))
    return { pass: false, reason: `必须返回${original.length}个完整分段。` };
  const problems: string[] = [];
  original.forEach((text, i) => {
    const result = proposed[i] as string;
    if (/\[停顿|\r|\n/u.test(result)) problems.push(`第${i+1}段不得添加停顿指令或内部换行。`);
    if (hanCount(text) !== hanCount(result) || spokenCharacters(text) !== spokenCharacters(result))
      problems.push(`第${i+1}段原为${hanCount(text)}个汉字、${spokenCharacters(text)}个正文字符，实际返回${hanCount(result)}个汉字、${spokenCharacters(result)}个正文字符，必须逐段完全相等。`);
  });
  return { pass: !problems.length, reason: problems.join(" ") };
}

/** 成品通过后仅问一次润色，字数/格式不符最多纠正一次；不继承音频通过状态。 */
export async function polishAcceptedScript(input: {
  stem: string; script: string; requiredParts: number; policy: BodyScriptPolicy;
  textJp: string; textZh: string; textEn: string;
}) {
  const original = acceptedScriptParts(input.script, input.requiredParts, input.policy);
  const outputPolicy: BodyScriptPolicy = input.requiredParts > 1 ? "lines" : input.policy;
  if (!original) return { changed: false, script: input.script, reason: "没有可靠的逐段文本边界，保留合格成品。", attempts: 0, policy: input.policy };
  const messages: ChatMessage[] = [{ role: "system", content:
    "你是游戏中文配音台词的最终文字润色编辑。当前稿已通过音频验收，只检查是否有更自然、凝练、优雅、适合人物说出口的表达，重点检查语序、修饰关系和生硬的翻译腔。\n硬要求：保持分段数量、顺序、每段汉字数及正文字符数完全不变，不跨段移动文字；每段核心语义、语气、对象、否定、条件、人物关系不变。优先段内移动已有词语，必要时可等字数替换，保留原中文准确自然的核心词和固定搭配，不堆修饰、不新增剧情。没有明显改善就原样返回，不为改而改。不要把自然口语改成生硬的书面训诫。遵守所给scriptPolicy；每个parts项对应一个原有大分片，保留并可调整片内自然标点，标点不计字数，不得添加停顿指令或段内换行。字数相同不代表时长相同，新稿仍要TTS和完整验收。\n只返回JSON：parts为完整分段字符串数组；reason说明具体语序和表达改善。" + "\n" + NATURAL_PUNCTUATION_HINT + "\n" + BILINGUAL_PAUSE_HINT },
    { role: "user", content: JSON.stringify({ japanese: input.textJp, originalChinese: input.textZh, english: input.textEn,
      scriptPolicy: outputPolicy, currentParts: original.map((text, index) => ({ index: index+1, text, hanCharacters: hanCount(text), spokenCharacters: spokenCharacters(text) })) }) }];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await callChatCompletion({ messages, temperature: .2, task: "accepted-script-polish", stem: input.stem, attempts: 1 });
    let parsed: { parts?: unknown; reason?: string } = {};
    try { parsed = JSON.parse(result.content); } catch { /* 格式错误走同一轮有界纠正。 */ }
    const check = validatePolishParts(original, parsed.parts);
    if (check.pass) {
      const parts = parsed.parts as string[];
      const script = input.requiredParts === 1 ? parts[0].trim() : scriptFromPolicyParts(parts, input.requiredParts, outputPolicy);
      if (script && (input.requiredParts === 1 || validBodyScript(script, input.requiredParts, outputPolicy)))
        return { changed: original.some((text, i) => text !== parts[i]) && script !== input.script, script, reason: parsed.reason || "逐段等字数润色", attempts: attempt, policy: outputPolicy };
    }
    if (attempt === 2) return { changed: false, script: input.script, reason: `润色未通过程序校验：${check.reason || "分片协议错误"}`, attempts: attempt, policy: input.policy };
    messages.push({ role: "assistant", content: result.content }, { role: "user", content: `程序核验未通过：${check.reason || "返回文本不符合分片协议"} 请纠正，优先通过段内语序调整改善口语，不要简单删字应付。无法改善可原样返回。` });
  }
  throw Error("润色流程未返回");
}
