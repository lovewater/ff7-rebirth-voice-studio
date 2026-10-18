import { performanceRewriteMessages } from "./auto-run-two-parts";
import { withRewriteNumberHint } from "./rewrite-number-hint";
import { resolvePromptMessages } from "./prompt-store";
import type { PromptMessage } from "./prompt-template";
import type { DurationRewritePolicy } from "./auto-run-script-policy";
import { retryRewriteDraft, type RewriteRetryEvent } from "./auto-run-rewrite-retry";
import { callChatCompletion, type ChatModelId } from "./llm-chat-client";
import { performanceSegmentationHint, checkShortCharacters, spokenCharacters, type ShortPerformancePolicy, type SlowPerformancePolicy } from "./auto-run-script-policy";
import { NORMAL_JP_CN_RATIO, type BeatResult } from "./beats";
import { parseRewrite, performanceLabel, rewriteMessages, rewritePace, REWRITE_COUNT, type ShowEvidence, type ShowLine } from "./rewrite-prompt";
import { normalizeScript } from "./tts-gpu";
import { spokenReviewMessages, parseSpokenReview, type SpokenReviewInput } from "./spoken-text-review";
import type { SeedAsrResult } from "./seed-asr";

export { loggedChatFetch, roundLlmInputText, CHAT_MODELS, chatModelForTask, chatModelConfigured } from "./llm-chat-client";

/** 业务模板入口：按任务选择模型；可选参数只用于显式覆盖，模板和访问日志始终统一处理。 */
export async function rewriteChat(messages: PromptMessage[], temperature = 0.2, task = "unspecified", httpTries = 3,
  options: { modelId?: ChatModelId; signal?: AbortSignal; stem?: string } = {}) {
  messages = withRewriteNumberHint(performanceRewriteMessages(messages, task));
  return callChatCompletion({ messages: await resolvePromptMessages(messages), temperature, task,
    attempts: httpTries, modelId: options.modelId, signal: options.signal, stem: options.stem,
    promptKeys: [...new Set(messages.flatMap(message => message.promptKey ? [message.promptKey] : []))] });
}

export function parseJsonObject(raw: string) {
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型未返回 JSON");
  return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
}

export async function judgeSpokenText(input: SpokenReviewInput) {
  const { content, thinking } = await rewriteChat(spokenReviewMessages(input), 0.1, "text-review");
  const parsed = parseJsonObject(content);
  return {
    ...parseSpokenReview(parsed, input.asr),
    thinking: (typeof parsed.thinking === "string" ? parsed.thinking : thinking).slice(0, 4000),
    raw: content,
  };
}

export async function pickRhythm(input: {
  textJp: string;
  jp: SeedAsrResult;
  candidates: {
    ttsId: string;
    spoken: string;
    asr: SeedAsrResult;
    paceRatio: number | null;
  }[];
}) {
  const { content, thinking } = await rewriteChat([
    {
      role: "system",
      content: [
        "你在为《最终幻想7 重生》场景演出挑一条中文配音。这些候选字和语速都已经过关。",
        "日文提供Seed-ASR字轴，中文提供本地Qwen识别和波形起止；中文没有字轴。根据实际提供的文字、波形跨度和长度比择优，不编造中文字轴或声学听感。",
        "只输出 JSON：ttsId 必须是候选里的 id；reason 一句话；thinking 判断过程。",
      ].join("\n"), promptKey: "rhythm-pick.system", promptValues: {},
    },
    {
      role: "user",
      content: JSON.stringify({
        textJp: input.textJp,
        jp: { text: input.jp.text, utterances: input.jp.raw },
        candidates: input.candidates.map((row) => ({
          ttsId: row.ttsId,
          spoken: row.spoken,
          paceRatio: row.paceRatio,
          asr: row.asr.raw,
        })),
      }), promptKey: "rhythm-pick.input", promptValues: {"input_json": JSON.stringify({
        textJp: input.textJp,
        jp: { text: input.jp.text, utterances: input.jp.raw },
        candidates: input.candidates.map((row) => ({
          ttsId: row.ttsId,
          spoken: row.spoken,
          paceRatio: row.paceRatio,
          asr: row.asr.raw,
        })),
      })},
    },
  ], 0.2, "rhythm-pick");
  const parsed = parseJsonObject(content);
  const ttsId = typeof parsed.ttsId === "string" || typeof parsed.ttsId === "number"
    ? String(parsed.ttsId)
    : "";
  const chosen = input.candidates.find((row) => row.ttsId === ttsId) ?? input.candidates[0];
  return {
    ttsId: chosen.ttsId,
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 1000) : "",
    thinking: (typeof parsed.thinking === "string" ? parsed.thinking : thinking).slice(0, 4000),
    raw: content,
  };
}

const REWRITE_TEMPS = [0.4, 0.55, 0.7, 0.6, 0.5];

export async function rewriteFive(input: {
  speaker: string;
  show: string | null;
  textJp: string;
  textEn: string;
  original: string;
  current: string;
  beats: BeatResult;
  before: ShowLine[];
  after: ShowLine[];
  jpAsr: SeedAsrResult;
  failNotes: string[];
  extraUser?: string;
  shortLine?: ShortPerformancePolicy & { target: number };
  slowLine?: SlowPerformancePolicy;
  durationLine?: DurationRewritePolicy;
  measure: (text: string) => Promise<BeatResult>;
  onRetry?: (event: RewriteRetryEvent) => Promise<void>;
}) {
  const previous: { raw: string; units: number | null; spokenUnits: number | null; text: string }[] = [];
  const drafts: {
    text: string;
    situation: string;
    problem: string;
    plan: string;
    risk: string;
    thinking: string;
    beats: BeatResult | null;
    spoken: BeatResult | null;
  }[] = [];
  for (let attempt = 0; attempt < REWRITE_COUNT; attempt += 1) {
    const messages = rewriteMessages({
      attempt,
      speaker: input.speaker,
      show: input.show,
      textJp: input.textJp,
      textEn: input.textEn,
      original: input.original,
      current: input.current,
      beats: input.beats,
      before: input.before,
      after: input.after,
      previous,
      segmentationHint: performanceSegmentationHint(input.textJp),
      shortLine: input.shortLine,
      slowLine: input.slowLine,
      durationLine: input.durationLine,
    });
    messages.push({
      role: "user",
      content: [
        "额外参考：日文 Seed-ASR 的音节、语速和停顿。改稿时把这些时间信息考虑进去，但仍然只输出原来的改写 JSON。",
        input.extraUser || "",
        JSON.stringify({
          jpAsr: input.jpAsr.raw,
          failNotes: input.failNotes,
        }),
      ].filter(Boolean).join("\n"), promptKey: "rewrite.audio-feedback", promptValues: {"audio_feedback": input.extraUser ? input.extraUser + "\n" : "","input_json": JSON.stringify({
          jpAsr: input.jpAsr.raw,
          failNotes: input.failNotes,
        })},
    });
    // 正常五稿中的单稿：网络/截断/JSON 或 text 校验失败最多重试三次。
    // 这里统一控制重试，关闭 rewriteChat 自带的 HTTP 500 重试，避免双层放大请求数。
    // 拍数测量位于重试外，服务不可用不能被误判为模型没有返回台词。
    const { draft, thinking } = await retryRewriteDraft(attempt + 1, async () => {
      const result = await rewriteChat(messages, REWRITE_TEMPS[attempt] ?? 0.55, "script-rewrite", 1);
      return { draft: parseRewrite(result.content), thinking: result.thinking };
    }, input.onRetry);
    const measure = async (text: string) => {
      try { return await input.measure(text); }
      catch (error) {
        // 实测偏短分支中拍数仅供诊断，服务不可用也不能阻断自然增字稿；未知仍记null。
        if (input.durationLine) return null;
        throw error;
      }
    };
    const beats = await measure(draft.text);
    const spoken = await measure(normalizeScript(draft.text, input.original).ttsText);
    previous.push({
      raw: draft.raw,
      units: beats?.cn.units ?? null,
      spokenUnits: spoken?.cn.units ?? null,
      text: draft.text,
    });
    drafts.push({
      ...draft,
      thinking: thinking.slice(0, 4000),
      beats,
      spoken,
    });
  }
  const shortLine = input.shortLine;
  const slowLine = input.slowLine;
  // 慢速稿不以常规拍数比筛掉，按中文字符数到纯摩拉目标的距离排序。
  const inBand = drafts.filter((row) => input.durationLine ? true : slowLine ? slowLine.max == null || (spokenCharacters(row.text) <= slowLine.max && spokenCharacters(normalizeScript(row.text, input.original).ttsText) <= slowLine.max) : shortLine
    ? checkShortCharacters(shortLine, row.text).pass && checkShortCharacters(shortLine, normalizeScript(row.text, input.original).ttsText).pass
    : (
    row.beats?.normalizedRatio != null
    && rewritePace(row.beats?.normalizedRatio, input.textJp) === "正常"
    && row.spoken?.normalizedRatio != null
    && rewritePace(row.spoken?.normalizedRatio, input.textJp) === "正常"
  ));
  const pool = inBand.length ? inBand : drafts;
  const chosen = pool.reduce((best, row) => {
    const score = (item: typeof row) => input.durationLine
      ? Math.abs(spokenCharacters(normalizeScript(item.text, input.original).ttsText) - input.durationLine.target)
      : slowLine
      ? Math.abs(spokenCharacters(normalizeScript(item.text, input.original).ttsText) - slowLine.target)
      : shortLine
      ? Math.abs(spokenCharacters(item.text) - shortLine.target)
      : Math.abs((item.beats?.normalizedRatio ?? 1) - 1);
    return score(row) < score(best) ? row : best;
  });
  return {
    ...chosen,
    candidates: drafts.map((row) => ({
      text: row.text,
      ratio: row.beats?.normalizedRatio ?? null,
      spokenRatio: row.spoken?.normalizedRatio ?? null,
    })),
    pickedInBand: inBand.includes(chosen),
    target: input.durationLine ? input.durationLine.target : slowLine ? slowLine.target : shortLine ? shortLine.target : input.beats.jp.units! / NORMAL_JP_CN_RATIO,
  };
}

export function showEvidenceLabel(evidence: ShowEvidence | null) {
  return performanceLabel(evidence);
}
