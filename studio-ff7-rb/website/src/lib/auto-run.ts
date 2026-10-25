import { stripInlinePinyin } from "./inline-pinyin";
import { locatePreservedTail, tailBodyAsr, tailBodyAudio, appendPreservedTail, preservedBodyDurationMs, type PreservedTail } from "./preserved-tail";
import { referenceWordEvidence } from "./reference-word-evidence";
import { rememberRoundSpeed } from "./round-speed-context";
import type { CandidateSpeedMeasurements } from "./selection-speed";
import { speechChunks } from "./speech-segments";
import { STRETCH_ALGORITHM } from "./rubberband-core";
import { applyAmbientPolicy, IGNORED_AMBIENT_MAX_MS, type AmbientPolicyPlan } from "./ambient-policy";
import { rewriteContextChinese } from "./rewrite-context";
import { currentChatModel } from "./llm-model-context";
import { fitItalicAudio, italicCandidateDecision } from "./italic-timing";
import { captureAutoRunOutcome, runAutoRunModels } from "./auto-run-model-policy";
import { polishAcceptedScript } from "./accepted-script-polish";
import type { AttemptInput } from "./attempt-feedback";
import { measureNormalSpeedBeatExemption } from "./normal-speed-beat";
import { pureShushuOriginal } from "./shushu-emotion";
import { isSingingLine, singingSubtitle } from "./singing-original";
import { allowBodyRewrite, bodyScriptPolicy, validBodyScript, type BodyScriptPolicy } from "./two-part-script";
import { TWO_PART_JP_GAP_S } from "./gap-only-align";
import { alignZeroShotParts, PartAssemblyError, ASSEMBLY_LENGTH_TOLERANCE_S, assemblyLengthPass } from "./auto-run-part-alignment";
import { rememberAttempt, hasAttemptHistory, countParts, repairTwoParts, setReference, rememberRhythm, rankByRhythm, inspectFinal, alignmentCheck, assemblePreserved, setMeaningAnchor, setBodyScriptPolicy, withTwoPartContext } from "./auto-run-two-parts";
import { localTtsAsr, needsChineseCutAxis } from "./tts-local-asr";
import { quickTimingPass, quickBeatPass } from "./auto-run-quick";
import { runFallbackFeedback, type FallbackTiming } from "./fallback-feedback";
import { classifyMissingJapaneseSubtitle } from "./missing-jp-subtitle";
import { finalizeAutoSubtitle } from "./final-auto-subtitle";
import { missingAudioBlocks, classifyMissingFragment, recoverMissingFragment, recoverCompleteTextAmbient, internalAmbientEvidence } from "./missing-fragment";
import { RewriteDraftUnavailableError } from "./auto-run-rewrite-retry";
import { addSubtitleQuotes, needsSubtitleQuotes } from "./subtitle-quotes";
import { withLlmMetrics, llmMetricsForRun } from "./llm-metrics";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { sql } from "./db";
import { AUTO_RUN_MAX_ROUNDS, LENGTH_SLACK_S, PACE_LOW, PACE_HIGH, isPerformanceMode, paceEnabled } from "./auto-run-rules";
import { judgeSpokenText, pickRhythm, rewriteFive, showEvidenceLabel, rewriteChat, parseJsonObject } from "./auto-run-llm";
import { planOnomatopoeia, planSpliceAfterTts, type OnoPlan, type SplicePiece } from "./auto-run-onomatopoeia";
import { audioToMonoWav, spliceMix } from "./audio-splice";
import { splitAsrClausesByOriginalPauses, alignJapaneseClauses, refinePerformanceBoundaries, segmentPerformanceAudio, measurePerformanceSpeakingTime, SEGMENT_MIN_SILENCE_MS, SEGMENT_SILENCE_RATIO } from "./speech-segmentation";
import { qwenAsr } from "./qwen-asr";
import { packSeedAsr, seedAsr, seedCacheMatches, seedLangForPath, unpackSeedAsr, type SeedAsrLang, type SeedAsrResult, type SeedAsrStored } from "./seed-asr";
import { normalizeScript, parseWavPcm16, wavTiming } from "./tts-gpu";
import { buildSpeechReference } from "./tts-reference";
import { clearlyShortSpeakingRound, durationRewritePolicy, type DurationRewritePolicy, checkChineseSpeakingSpeed, autoBeatBand, checkAutoBeat, shortPerformancePolicy, checkShortCharacters, shortAudioDirection, SHORT_NET_SPEAKING_TOLERANCE_MS, spokenCharacters, slowPerformancePolicy, slowMoraTargetConflict, performanceCharacterLimit } from "./auto-run-script-policy";
import { autoRunSubtitle, twoLineSubtitle, subtitleRestorePlan, restorePerformanceSubtitle } from "./auto-run-subtitle";
import { createAutoRunSubtitleFormatter } from "./auto-run-subtitle-format";
import { closestFallback, type FallbackQuality } from "./auto-run-fallback";
import { fewestPronunciationIssues, shouldRetrySameScript } from "./spoken-text-review";
import { compareReadingSpans, measureReadingSpan } from "./reading-span";
import { fastLongPressure } from "./fast-long-pressure";
import { recognizedSpeechSpan } from "./auto-run-comparison";
import { decodeWavMono } from "./wav-stretch";
import { measureSavedEdit } from "./speech-metrics-store";
import { samePerformance, takeUntilBoundary, type ShowEvidence, type ShowLine } from "./rewrite-prompt";
import type { Pronunciation } from "./pronounce";
import { type BeatResult } from "./beats";

export type AutoRunEvent = {
  id: string;
  at: string;
  step: string;
  level: "info" | "think" | "asr" | "result" | "error";
  message: string;
  payload: unknown;
};

export type AutoRunRow = {
  id: string;
  stem: string;
  kind: "performance" | "casual";
  status: "running" | "passed" | "failed";
  selected_tts_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  reference_audio_path: string | null;
  reference_text_jp: string | null;
  reference_seed_asr: SeedAsrStored | null;
};

type LinePack = {
  stem: string;
  speaker: string | null;
  name_zh: string | null;
  kind: string | null;
  text_jp: string | null;
  text_zh: string | null;
  text_en: string | null;
  subtitle_italic: boolean;
  dialogue_mode: string | null;
  dialogue_evidence: ShowEvidence | null;
  jp_dur_s: number | null;
};

type TtsClip = {
  id: string;
  tts_text: string;
  spoken_text: string;
  dur_s: number | null;
  audio_path: string | null;
  speech_pass: boolean | null;
  speech_score?: number | null;
  conversion_meta?: { two_parts_regroup?: import("./two-part-regroup").RegroupMeta; auto_run_gap_alignment?: import("./auto-run-part-alignment").PartAlignmentMeta } | null;
};

type RecoveryCandidate = FallbackQuality & {
  clip: TtsClip;
  asr?: SeedAsrResult;
  cutAxisRequested?: boolean;
  reason?: string;
  assembledId?: string;
  workflow?: "current-script-fallback";
  normalSpeedBeat?: ReturnType<typeof measureNormalSpeedBeatExemption>;
  attemptInput?: AttemptInput;
};
/** 将真正保存的音频与稿件绑定，历史说明与日志使用同一个计算结果。 */
async function saveAttemptFeedback(runId: string, candidate: RecoveryCandidate, input: AttemptInput) {
  candidate.attemptInput = structuredClone(input);
  const feedback = rememberAttempt(input);
  if (!feedback) return;
  await sql`UPDATE line_tts_versions SET conversion_meta=COALESCE(conversion_meta,'{}'::jsonb)||${sql.json({attempt_feedback:feedback})} WHERE id=${candidate.clip.id}`;
  await log(runId,"attempt-feedback",`#${candidate.clip.id} ${feedback.status}：${feedback.issues.map(i=>i.reason).join("")||feedback.missingChecks.join("；")||"本轮检查通过"}`,feedback,"result");
}
type RunRecovery = {
  candidates: RecoveryCandidate[];
  assemble?: (candidate: RecoveryCandidate) => Promise<string>;
  /** 润色前已完成最终验收的成品，仅用于润色失败时恢复。 */
  acceptedFinalId?: string;
};

function rememberCandidates(recovery: RunRecovery, clips: TtsClip[], target: number | null) {
  // 文件一生成就登记；即使后续 ASR/模型/改稿服务异常，也保留可播放的兜底。
  const rows = clips.filter((clip) => clip.audio_path).map((clip) => ({
    clip, reviewed: false, hardIssueCount: 0, pronunciationIssueCount: 0,
    paceDeviation: null, beatDeviation: null,
    durationDeviation: target != null && clip.dur_s != null ? Math.abs(clip.dur_s - target) : null,
  } as RecoveryCandidate));
  recovery.candidates.push(...rows);
  return rows;
}

/** 已有候选兜底线路：正常三轮质量检查均不过，或意外服务异常中断后，从已生成候选择优。
 * 这条线路不额外合成；有装配上下文就编辑，装配失败仍保留可播放候选，始终待复核。
 * 改稿请求重试耗尽应进入 runCurrentScriptFallback，不能直接走这里省掉三次合成。
 */
async function finishWithFallback(runId: string, recovery: RunRecovery, reason: string) {
  if (recovery.acceptedFinalId) {
    const [accepted] = await sql<{id:string}[]>`SELECT id::text FROM line_tts_versions WHERE id=${recovery.acceptedFinalId} AND status='ready' AND review_state<>'abnormal'`;
    if (accepted) {
      await log(runId,"polish-fallback","润色复验未通过，保留原合格成品",{id:accepted.id,reason},"result");
      await finish(runId,"passed",null,accepted.id);
      return;
    }
    // 人工否决或删除原合格成品后，不能再经正文缓存把同一成品选回来。
    await finish(runId,"failed",`${reason}；原合格成品已不存在或被标为人工异常`,null);
    return;
  }
  // 人工在生成过程中标坏的候选不能再被兜底择优选回。
  const rejected = recovery.candidates.length ? await sql<{ id: string }[]>`
    SELECT id::text FROM line_tts_versions
    WHERE id = ANY(${recovery.candidates.map(row => Number(row.clip.id))}::bigint[]) AND review_state='abnormal'
  ` : [];
  const rejectedIds = new Set(rejected.map(row => row.id));
  const chosen = closestFallback(recovery.candidates.filter(row => !rejectedIds.has(row.clip.id)));
  if (!chosen) {
    await finish(runId, "failed", `${reason}；没有已生成的可用音频`, null);
    return;
  }
  let selected = chosen.clip.id;
  if (recovery.assemble) {
    try { selected = await recovery.assemble(chosen); }
    catch (error) {
      await log(runId, "fallback", "兜底拼接异常，保留已生成的正文音频", {
        ttsId: selected, error: error instanceof Error ? error.message : String(error),
      }, "error");
    }
  }
  await log(runId, "fallback", `校字硬伤最少的候选中，按实际时长选择 #${selected}，待复核`, {
    sourceId: chosen.clip.id, selectedId: selected, reason,
    selection: "reviewed-text-then-duration", beatUsedForSelection: false, paceRatioUsedForSelection: false,
    candidates: recovery.candidates.map((row) => ({
      ttsId: row.clip.id, reviewed: row.reviewed, hardIssueCount: row.hardIssueCount,
      pronunciationIssueCount: row.pronunciationIssueCount, paceDeviation: row.paceDeviation, beatDeviation: row.beatDeviation,
      durationDeviation: row.durationDeviation, reason: row.reason,
    })),
  }, "result");
  // failed + selected 明确表示有产物但未通过，不能伪装通过或自动锁定。
  await finish(runId, "failed", `${reason}；已保留最接近要求的音频，待复核`, selected);
}

const STALE_MS = 30 * 60 * 1000;

function origin() {
  return process.env.AUTO_RUN_ORIGIN ?? "http://127.0.0.1:8765";
}

function dataFile(...parts: string[]) {
  return path.join(process.cwd(), "data", ...parts);
}

function audioFormat(filePath: string): "mp3" | "wav" {
  return filePath.toLowerCase().endsWith(".wav") ? "wav" : "mp3";
}

async function log(runId: string | number, step: string, message: string, payload: unknown = {}, level: AutoRunEvent["level"] = "info") {
  await sql`
    INSERT INTO line_auto_run_events (run_id, step, level, message, payload)
    VALUES (${runId}, ${step}, ${level}, ${message}, ${sql.json(JSON.parse(JSON.stringify(payload ?? {})))})
  `;
  await sql`UPDATE line_auto_runs SET updated_at = now() WHERE id = ${runId}`;
}

async function finish(runId: string | number, status: "passed" | "failed", error: string | null, selected: string | null, options: { preserveSubtitle?: boolean; noModelRetry?: boolean } = {}) {
  if (captureAutoRunOutcome({ status, error, selected, options })) return;
  // 最终选定音频后才独立整理字幕引号，不给五稿改写增加任务，也不反向影响音频。
  if (selected != null && !options.preserveSubtitle) {
    const [caption] = await sql<{ japanese: string; chinese: string }[]>`
      SELECT COALESCE(l.text_jp, '') AS japanese, COALESCE(NULLIF(v.subtitle_text, ''), l.text_zh, '') AS chinese
      FROM line_tts_versions v JOIN line_auto_runs r ON r.id = ${runId} AND r.stem = v.stem
      JOIN lines l ON l.stem = v.stem WHERE v.id = ${selected} AND v.status = 'ready' AND v.review_state <> 'abnormal'
    `;
    if (caption && needsSubtitleQuotes(caption.japanese, caption.chinese)) {
      try {
        const quoted = await addSubtitleQuotes(caption.japanese, caption.chinese);
        const changed = await sql`
          UPDATE line_tts_versions v SET subtitle_text = ${quoted} FROM lines l
          WHERE v.id = ${selected} AND v.stem = l.stem
            AND COALESCE(NULLIF(v.subtitle_text, ''), l.text_zh, '') = ${caption.chinese}
          RETURNING v.id
        `;
        if (changed.length) await log(runId, "subtitle-quotes", "最终字幕单独补回日文引用词对应的引号，正文保持不变", { ttsId: selected, before: caption.chinese, after: quoted }, "result");
        else await log(runId, "subtitle-quotes", "字幕已由其他操作更新，保留现有字幕", { ttsId: selected }, "result");
      } catch (quoteError) {
        // 字幕整理失败不能让已经生成的音频丢失；保留原字幕和明确错误记录。
        await log(runId, "subtitle-quotes", "补引号失败，保留已生成音频及原字幕", { ttsId: selected, error: quoteError instanceof Error ? quoteError.message : String(quoteError) }, "error");
      }
    }
  }
  // 只在最终选定成品上重新排版；候选/TTS分行不再决定字幕切口。
  // 本地函数在事务外排版，且不覆盖期间被人工锁定或改过的字幕。
  if (selected != null && !options.preserveSubtitle) {
    const [caption] = await sql<{text:string; source:string}[]>`
      SELECT COALESCE(NULLIF(v.subtitle_text,''),l.text_zh,'') AS text, v.tts_text AS source
      FROM line_tts_versions v JOIN lines l ON l.stem=v.stem
      WHERE v.id=${selected} AND v.status='ready' AND v.review_state='candidate'`;
    if (caption?.text) try {
      const formatted = await createAutoRunSubtitleFormatter({ reflow: true })(caption.text, caption.source);
      if (formatted !== caption.text) {
        const changed = await sql`UPDATE line_tts_versions v SET subtitle_text=${formatted} FROM lines l
          WHERE v.id=${selected} AND v.stem=l.stem AND v.review_state='candidate'
            AND COALESCE(NULLIF(v.subtitle_text,''),l.text_zh,'')=${caption.text} RETURNING v.id`;
        await log(runId,"subtitle-reflow",changed.length ? "最终字幕脱离TTS分段，按本地规则重新排版" : "字幕已由人工更新，保留现有内容",{ttsId:selected,before:caption.text,after:formatted},"result");
      }
    } catch (error) {
      await log(runId,"subtitle-reflow","本地排版失败，保留成品及现有字幕待核对",{ttsId:selected,error:String(error)},"error");
    }
  }
  // 聚合包括最终补引号的所有 LLM 请求；无调用则两个字段都为 NULL。
  // 与父子归组同事务写入，候选字段清空，始终只有最终主音频承担这次工作流用量。
  const metrics = await llmMetricsForRun(runId);
  await sql.begin(async (tx) => {
    const [run] = await tx<{ stem: string }[]>`SELECT stem FROM line_auto_runs WHERE id = ${runId} FOR UPDATE`;
    if (!run) throw new Error("自动运行记录不存在");
    if (selected != null) {
      const [output] = await tx<{ id: string; review_state: string; subtitle_text: string | null; original_subtitle: string }[]>`
        SELECT v.id::text, v.review_state, v.subtitle_text, COALESCE(l.text_zh, '') AS original_subtitle
        FROM line_tts_versions v JOIN lines l ON l.stem = v.stem
        WHERE v.id = ${selected} AND v.stem = ${run.stem} AND v.status = 'ready'
        FOR UPDATE OF v
      `;
      if (!output) throw new Error("自动运行最终音频不存在或尚未就绪");
      if (output.review_state === "abnormal") {
        // 最后确认与手动标记同一行锁，不能让后台完成回调重新推荐人工否决的音频。
        await tx`UPDATE line_auto_runs SET status='failed', error='候选已由人工标记异常，保留音频但不推荐',
          selected_tts_id=NULL, completed_at=now(), updated_at=now() WHERE id=${runId}`;
        return;
      }
      // 最后一道字幕整理：拟声已恢复、引号已补完；短两行合一后，再忽略标点比较原文。
      // 即使仍有两行，只要正文没变就清空覆盖字幕；绝不写tts_text/spoken_text或子音频。
      // 直接日文原声线路明确保留附带字幕，不走自动改稿收尾。
      if (!options.preserveSubtitle && output.review_state === "candidate" && output.subtitle_text) {
        const cleaned = finalizeAutoSubtitle(output.subtitle_text, output.original_subtitle);
        if (cleaned !== output.subtitle_text) {
          await tx`UPDATE line_tts_versions SET subtitle_text = ${cleaned} WHERE id = ${selected}`;
          await tx`
            INSERT INTO line_auto_run_events (run_id, step, level, message, payload)
            VALUES (${runId}, 'subtitle-finalize', 'result', ${cleaned === null ? "最终字幕正文与原字幕一致，沿用原字幕，不标改" : "最终字幕整理：短行合并、换行处逗号句号清理，保留TTS朗读稿中的停顿"},
              ${tx.json({ ttsId: String(selected), before: output.subtitle_text, after: cleaned, original: output.original_subtitle })})
          `;
          output.subtitle_text = cleaned;
        }
      }
      if (output.subtitle_text) {
        await tx`
          INSERT INTO line_auto_run_events (run_id, step, level, message, payload)
          VALUES (${runId}, 'subtitle', 'result', ${`最终 #${selected} 同步改写字幕`},
            ${tx.json({ ttsId: String(selected), subtitleText: output.subtitle_text })})
        `;
      }
      // 每轮 TTS 和中间拼接产物均登记归属；结束时统一收在最终推荐下面。
      // 兜底推荐也建立相同层级，展示关系不改变 review_state、试听或原始来源信息。
      await tx`
        UPDATE line_tts_versions SET
          parent_tts_id = CASE WHEN id = ${selected}::bigint THEN NULL ELSE ${selected}::bigint END,
          llm_tokens = CASE WHEN id = ${selected}::bigint THEN ${metrics.tokens === null ? null : tx.json(metrics.tokens)}::jsonb ELSE NULL END,
          llm_speed = CASE WHEN id = ${selected}::bigint THEN ${metrics.speed === null ? null : tx.json(metrics.speed)}::jsonb ELSE NULL END
        WHERE auto_run_id = ${runId} AND stem = ${run.stem}
      `;
    }
    await tx`
      UPDATE line_auto_runs SET status = ${status}, error = ${error}, selected_tts_id = ${selected},
        completed_at = now(), updated_at = now() WHERE id = ${runId}
    `;
  });
}

async function loadLine(stem: string) {
  const [line] = await sql<LinePack[]>`
    SELECT l.stem, l.speaker, COALESCE(s.name_zh, l.speaker) AS name_zh, l.kind,
           l.text_jp, l.text_zh, l.text_en, l.subtitle_italic, m.dialogue_mode,
           m.dialogue_evidence, m.jp_dur_s
    FROM lines l
    LEFT JOIN speakers s ON s.code = l.speaker
    LEFT JOIN line_meta m ON m.stem = l.stem
    WHERE l.stem = ${stem}
  `;
  return line ?? null;
}

async function lexicon() {
  return sql<Pronunciation[]>`SELECT id, src, dst, note FROM pronunciations WHERE usage = 'reference' ORDER BY id`;
}

async function generateClone(runId: string, stem: string, ttsText: string, extra?: {
  promptPath?: string;
  layoutSlot?: { start: number; dur: number; speech: number };
  alignStartS?: number | null;
  preservePromptAudio?: boolean;
  manualTemplates?: boolean;
  feedbackRound?: boolean;
  bodyScriptPolicy?: BodyScriptPolicy;
  subtitleText?: string | null;
  finalSubtitleText?: string | null;
}) {
  const response = await fetch(`${origin()}/api/lines/${encodeURIComponent(stem)}/tts/clone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(1_200_000),
    body: JSON.stringify({
      ttsText,
      autoRunId: runId,
      autoRunModel: currentChatModel() ?? "primary",
      subtitleText: extra?.subtitleText,
      finalSubtitleText: extra?.finalSubtitleText,
      promptLang: "jp",
      promptStem: stem,
      durationFactor: 1,
      promptPath: extra?.promptPath,
      layoutSlot: extra?.layoutSlot,
      alignStartS: extra?.alignStartS,
      preservePromptAudio: extra?.preservePromptAudio,
      manualTemplates: extra?.manualTemplates,
      feedbackRound: extra?.feedbackRound,
      bodyScriptPolicy: extra?.bodyScriptPolicy,
    }),
  });
  const data = await response.json() as { error?: string; ids?: unknown; id?: unknown };
  if (!response.ok) throw new Error(data.error || `TTS HTTP ${response.status}`);
  const ids = (Array.isArray(data.ids) ? data.ids : data.id != null ? [data.id] : []).map(String);
  if (!ids.length) throw new Error("TTS 没有返回音频");
  const rows = await sql<TtsClip[]>`
    SELECT id::text AS id, tts_text, spoken_text, dur_s, audio_path, conversion_meta,
           (conversion_meta->>'speech_pass')::boolean AS speech_pass,
           (conversion_meta->>'speech_score')::float8 AS speech_score
    FROM line_tts_versions
    WHERE stem = ${stem} AND id = ANY(${ids.map((id) => Number(id))}::bigint[]) AND review_state <> 'abnormal'
    ORDER BY id
  `;
  return rows;
}

async function readAudioB64(relative: string) {
  const buf = await readFile(dataFile(relative));
  return { b64: buf.toString("base64"), format: audioFormat(relative) };
}

async function asrQwen(clip: TtsClip) {
  if (!clip.audio_path) throw new Error(`#${clip.id} 没有音频文件`);
  const { b64 } = await readAudioB64(clip.audio_path);
  return qwenAsr(b64);
}

type AsrOwner = { stem: string; ttsId?: string; referenceRunId?: string };

async function findSeedAsr(digest: string, language: SeedAsrLang, where: AsrOwner) {
  const hit = (value: unknown) => {
    const packed = unpackSeedAsr(value);
    return seedCacheMatches(packed, digest, language) ? packed : null;
  };
  if (where.referenceRunId) {
    const [row] = await sql<{ seed_asr: unknown }[]>`
      SELECT reference_seed_asr AS seed_asr FROM line_auto_runs WHERE id = ${Number(where.referenceRunId)} AND stem = ${where.stem}
    `;
    const packed = hit(row?.seed_asr);
    if (packed) return packed;
  } else if (where.ttsId) {
    const [row] = await sql<{ seed_asr: unknown }[]>`
      SELECT seed_asr FROM line_tts_versions WHERE id = ${Number(where.ttsId)} LIMIT 1
    `;
    const packed = hit(row?.seed_asr);
    if (packed) return packed;
  } else {
    const [row] = await sql<{ seed_asr: unknown }[]>`
      SELECT seed_asr FROM line_meta WHERE stem = ${where.stem} LIMIT 1
    `;
    const packed = hit(row?.seed_asr);
    if (packed) return packed;
  }
  const [fromTts] = await sql<{ seed_asr: unknown }[]>`
    SELECT seed_asr FROM line_tts_versions
    WHERE seed_asr->>'sha256' = ${digest}
      AND COALESCE(seed_asr->>'language', 'zh-CN') = ${language}
    LIMIT 1
  `;
  const ttsHit = hit(fromTts?.seed_asr);
  if (ttsHit) return ttsHit;
  const [fromMeta] = await sql<{ seed_asr: unknown }[]>`
    SELECT seed_asr FROM line_meta
    WHERE seed_asr->>'sha256' = ${digest}
      AND COALESCE(seed_asr->>'language', 'zh-CN') = ${language}
    LIMIT 1
  `;
  const metaHit = hit(fromMeta?.seed_asr);
  if (metaHit) return metaHit;
  const [fromReference] = await sql<{ seed_asr: unknown }[]>`
    SELECT reference_seed_asr AS seed_asr FROM line_auto_runs
    WHERE reference_seed_asr->>'sha256' = ${digest}
      AND reference_seed_asr->>'language' = ${language}
    LIMIT 1
  `;
  return hit(fromReference?.seed_asr);
}

async function saveSeedAsr(where: AsrOwner, stored: SeedAsrStored) {
  const payload = sql.json(JSON.parse(JSON.stringify(stored)));
  if (where.referenceRunId) {
    // 参考 ASR 属于本次运行；绝不能覆盖 line_meta 中整句日文原声的识别。
    await sql`UPDATE line_auto_runs SET reference_seed_asr = ${payload}
      WHERE id = ${Number(where.referenceRunId)} AND stem = ${where.stem}`;
    return;
  }
  if (where.ttsId) {
    await sql`UPDATE line_tts_versions SET seed_asr = ${payload} WHERE id = ${Number(where.ttsId)}`;
    return;
  }
  await sql`
    INSERT INTO line_meta (stem, seed_asr, updated_at)
    VALUES (${where.stem}, ${payload}, now())
    ON CONFLICT (stem) DO UPDATE SET seed_asr = EXCLUDED.seed_asr, updated_at = now()
  `;
}

async function asrSeedFile(relative: string, where: AsrOwner, explicitLanguage?: SeedAsrLang) {
  const buf = await readFile(dataFile(relative));
  const digest = createHash("sha256").update(buf).digest("hex");
  // 清理后的日文 WAV 存在 tts/ 下，不能按目录把它误认成中文。
  if (where.referenceRunId && explicitLanguage !== "ja-JP") throw new Error("日文参考 ASR 必须显式指定 ja-JP");
  const language = seedLangForPath(relative, explicitLanguage);
  const cached = await findSeedAsr(digest, language, where);
  if (cached) {
    const stored = { ...cached, path: relative };
    await saveSeedAsr(where, stored);
    return { result: stored as SeedAsrResult, stored, cached: true };
  }
  const result = await seedAsr(buf.toString("base64"), audioFormat(relative), language);
  const stored = packSeedAsr(result, digest, relative);
  await saveSeedAsr(where, stored);
  return { result, stored, cached: false };
}

async function saveSplicedEdit(runId: string, stem: string, sourceId: string, audio: Buffer, plan: OnoPlan, pieces: SplicePiece[], extra: Record<string, unknown> = {}) {
  const timing = wavTiming(audio);
  const source = (
    await sql<{
      speaker: string;
      tts_text: string;
      spoken_text: string;
      subtitle_text: string | null;
      conversion_meta: { auto_run_final_subtitle?: string | null; body_comparison?: Record<string,string|number|boolean|null>; chinese_speed?: Record<string,string|number|boolean|null> } | null;
      jp_text_snapshot: string | null;
      game_zh_text_snapshot: string | null;
      duration_factor: number;
    }[]>`
      SELECT speaker, tts_text, spoken_text, subtitle_text, conversion_meta,
             jp_text_snapshot, game_zh_text_snapshot, duration_factor
      FROM line_tts_versions
      WHERE id = ${Number(sourceId)} AND stem = ${stem} AND status = 'ready' AND review_state <> 'abnormal'
    `
  )[0];
  if (!source) throw new Error("拼接源记录不存在");
  // 子音频只含正文，字幕也只存正文；拼回原声后才使用恢复拟声的完整字幕。
  const finalSubtitleText = source.conversion_meta?.auto_run_final_subtitle ?? source.subtitle_text;
  const record = (
    await sql<{ id: string }[]>`
      INSERT INTO line_tts_versions (
        stem, auto_run_id, speaker, voice_version_id, voice_gpu_key,
        tts_text, spoken_text, subtitle_text,
        jp_text_snapshot, game_zh_text_snapshot,
        duration_factor, emo_alpha
      ) VALUES (
        ${stem}, ${runId}, ${source.speaker}, NULL, ${"audio-edit"},
        ${source.tts_text}, ${source.spoken_text}, ${finalSubtitleText == null ? null : twoLineSubtitle(finalSubtitleText)},
        ${source.jp_text_snapshot}, ${source.game_zh_text_snapshot},
        ${source.duration_factor}, ${0}
      )
      RETURNING id::text AS id
    `
  )[0];
  const relativePath = path.posix.join("tts", stem, `${record.id}.wav`);
  const absolutePath = path.join(process.cwd(), "data", relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, audio);
  const conversion = {
    pipeline: "audio-edit",
    stretch_algorithm: STRETCH_ALGORITHM,
    source_id: Number(sourceId),
    stem,
    onomatopoeia: plan.onomatopoeia,
    ambient: plan.ambient,
    speech: plan.speech,
    splice: pieces,
    ...(plan.preservedTail ? {preserved_tail:plan.preservedTail} : {}),
    ...(source.conversion_meta?.body_comparison ? {body_comparison:source.conversion_meta.body_comparison} : {}),
    ...(source.conversion_meta?.chinese_speed ? {chinese_speed:source.conversion_meta.chinese_speed} : {}),
    ...extra,
  };
  await sql`
    UPDATE line_tts_versions SET
      status = 'ready',
      audio_path = ${relativePath},
      audio_bytes = ${audio.length},
      start_s = ${timing.start},
      end_s = ${timing.end},
      dur_s = ${timing.duration},
      speech_s = ${timing.speech},
      conversion_meta = ${sql.json(conversion)},
      completed_at = now(),
      error = NULL
    WHERE id = ${record.id}
  `;
  await measureSavedEdit(stem, record.id).catch(() => {});
  return record.id;
}

async function countBeats(jp: string, cn: string, includeSpeechReading = false) {
  cn = stripInlinePinyin(cn);
  const response = await fetch(`${process.env.MORA_URL ?? "http://127.0.0.1:8000"}/beats`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairs: [{ jp, cn }], ...(includeSpeechReading ? { includeSpeechReading: true } : {}) }),
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("拍数计算服务暂不可用");
  return (await response.json() as { results: BeatResult[] }).results[0];
}

/** 快速线路使用完整日文参考，与整句Zero-shot一致；不使用列表旧字幕的比值缓存。
 * 净发声计算与完整线路相同，扣掉长静音，避免慢速豁免被长空白误触发。
 * 每条检查只复用本次调用内的参考音频测量，不能跨字幕/音频变化沿用旧结论。
 */
async function quickReferenceSpeechSeconds(stem: string) {
  const audio = await audioToMonoWav(await readFile(dataFile("jp", `${stem}.mp3`)));
  const timing = wavTiming(audio);
  const measured = measurePerformanceSpeakingTime({ ...decodeWavMono(audio), startS: timing.start, endS: timing.end });
  return measured && measured.speechSeconds > 0 ? measured.speechSeconds : null;
}

async function saveAutoRunComparison(
  runId: string, clip: TtsClip, reference: SeedAsrStored, candidate: Pick<SeedAsrStored, "path" | "sha256">,
  comparison: ReturnType<typeof compareReadingSpans>, referenceTextJp: string, candidateText: string,
  beat: { result: BeatResult | null; error: string | null },
) {
  if (!clip.audio_path) throw new Error("候选音频路径缺失，不能保存比较结果");
  // 比例必须和输入文件指纹、文字快照、规则版本一起保存。
  // 原 line_meta.beat_ratio 属于源字幕，不能拿某次 TTS 的结果覆盖整句缓存。
  await sql`
    INSERT INTO line_auto_run_comparisons (
      run_id, tts_id, metric_version, reference_audio_path, reference_sha256,
      candidate_audio_path, candidate_sha256, reference_span_ms, candidate_span_ms,
      span_ratio, span_check_enabled, span_pass, reference_text_jp, candidate_text_cn,
      beat_version, normalized_beat_ratio, beat_result, beat_error
    ) VALUES (
      ${Number(runId)}, ${Number(clip.id)}, ${comparison.metricVersion}, ${reference.path}, ${reference.sha256},
      ${candidate.path}, ${candidate.sha256}, ${comparison.jpSpan?.span ?? null}, ${comparison.cnSpan?.span ?? null},
      ${comparison.spanRatio}, ${comparison.enabled}, ${comparison.pass}, ${referenceTextJp}, ${candidateText},
      ${beat.result?.version ?? null}, ${beat.result?.normalizedRatio ?? null},
      ${beat.result ? sql.json(JSON.parse(JSON.stringify(beat.result))) : null}, ${beat.error}
    ) ON CONFLICT (run_id, tts_id) DO UPDATE SET
      metric_version = excluded.metric_version, reference_audio_path = excluded.reference_audio_path,
      reference_sha256 = excluded.reference_sha256, candidate_audio_path = excluded.candidate_audio_path,
      candidate_sha256 = excluded.candidate_sha256, reference_span_ms = excluded.reference_span_ms,
      candidate_span_ms = excluded.candidate_span_ms, span_ratio = excluded.span_ratio,
      span_check_enabled = excluded.span_check_enabled, span_pass = excluded.span_pass,
      reference_text_jp = excluded.reference_text_jp, candidate_text_cn = excluded.candidate_text_cn,
      beat_version = excluded.beat_version, normalized_beat_ratio = excluded.normalized_beat_ratio,
      beat_result = excluded.beat_result, beat_error = excluded.beat_error, measured_at = now()
  `;
  // 同一值同时存到候选JSON，组装主音频原样继承正文比较值，不把情绪/静音重算进去。
  const bodyComparison={metric_version:comparison.metricVersion,reference_audio_path:reference.path,
    reference_text_jp:referenceTextJp,candidate_text_cn:candidateText,
    reference_reading_ms:comparison.jpSpan?.span??null,candidate_reading_ms:comparison.cnSpan?.span??null,
    reading_duration_ratio:comparison.spanRatio,reading_duration_delta_ms:comparison.deltaMs??null,
    reading_duration_absolute_tolerance_ms:comparison.absoluteToleranceMs??0,reading_duration_pass:comparison.pass,
    reading_duration_ratio_pass:comparison.ratioPass??null,reading_duration_absolute_pass:comparison.absolutePass??null,
    ...("parts" in comparison?{parts:comparison.parts}:{}),normalized_beat_ratio:beat.result?.normalizedRatio??null,
    candidate_spoken_units:beat.result?.cn.han??null,
    beat_version:beat.result?.version??null,scope:"emotion-free-body",silence_removed:false,
    timing_policy:"within-part-pauses-included-between-part-gaps-excluded-v2"};
  await sql`UPDATE line_tts_versions SET conversion_meta=COALESCE(conversion_meta,'{}'::jsonb)||${sql.json({body_comparison:bodyComparison})} WHERE id=${clip.id}`;

}

type ContextRow = {
  stem: string;
  kind: string | null;
  name_zh: string | null;
  text_jp: string | null;
  text_en: string | null;
  text_zh: string | null;
  subtitle_text?: string | null;
  subtitle_italic: boolean;
  dialogue_mode: string | null;
  dialogue_evidence: ShowEvidence | null;
};

function asShowLine(row: ContextRow): ShowLine {
  return {
    speaker: row.name_zh || "未知",
    offscreen: row.subtitle_italic,
    textJp: row.text_jp || "",
    textEn: row.text_en || "",
    ...rewriteContextChinese(row.text_zh, row.subtitle_text),
  };
}

async function loadDialogueContext(stem: string) {
  // 前后文优先使用人工锁定后的中文；本句仍从游戏原字幕开始。
  const rows = await sql<ContextRow[]>`
    SELECT l.stem, COALESCE(s.name_zh, l.speaker) AS name_zh,
           l.text_jp, l.text_en, l.text_zh, l.subtitle_italic, l.kind,
           m.dialogue_mode, m.dialogue_evidence, tv.subtitle_text
    FROM lines l
    LEFT JOIN line_meta m ON m.stem = l.stem
    LEFT JOIN speakers s ON s.code = l.speaker
    LEFT JOIN LATERAL (
      SELECT COALESCE(NULLIF(BTRIM(v.subtitle_text), ''), l.text_zh, '') AS subtitle_text
      FROM line_tts_versions v
      WHERE v.stem=l.stem AND v.status='ready' AND v.review_state='locked'
      ORDER BY v.id DESC LIMIT 1
    ) tv ON true
    WHERE l.id BETWEEN
      (SELECT id FROM lines WHERE stem = ${stem}) - 80
      AND (SELECT id FROM lines WHERE stem = ${stem}) + 80
    ORDER BY l.id
  `;
  const currentIndex = rows.findIndex((row) => row.stem === stem);
  const line = rows[currentIndex];
  if (!line || !line.text_jp || !line.text_zh) throw new Error("缺少日文或中文原文，无法改稿");
  const inside = (row: ContextRow) => row.dialogue_mode === "scene"
    && samePerformance(line.dialogue_evidence, row.dialogue_evidence)
    && !!(row.text_jp || row.text_zh);
  const context = takeUntilBoundary(rows, currentIndex, inside, 8);
  return { line, before: context.before.map(asShowLine), after: context.after.map(asShowLine) };
}

async function loadRewriteContext(stem: string, current: string, referenceTextJp?: string) {
  // current 仅为本次运行内部产生的清理稿/改写稿。
  const context = await loadDialogueContext(stem);
  const beats = await countBeats(referenceTextJp ?? context.line.text_jp!, current);
  return { ...context, beats };
}

export async function latestAutoRun(stem: string) {
  // SELECT把id转为text供JSON使用；排序必须显式用表内数字ID，避免888排在1781前。
  const [run] = await sql<AutoRunRow[]>`
    SELECT id::text, stem, kind, status, selected_tts_id::text, error,
           created_at, updated_at, completed_at,
           reference_audio_path, reference_text_jp, reference_seed_asr
    FROM line_auto_runs WHERE stem = ${stem}
    ORDER BY line_auto_runs.id DESC LIMIT 1
  `;
  if (!run) return { run: null, events: [] as AutoRunEvent[], comparisons: [] };
  const events = await sql<AutoRunEvent[]>`
    SELECT id::text, at, step, level, message, payload
    FROM line_auto_run_events WHERE run_id = ${run.id}
    ORDER BY line_auto_run_events.id
  `;
  const comparisons = await sql`
    SELECT tts_id::text, metric_version, reference_audio_path, reference_sha256,
           candidate_audio_path, candidate_sha256, reference_span_ms, candidate_span_ms,
           span_ratio, span_check_enabled, span_pass, reference_text_jp, candidate_text_cn,
           beat_version, normalized_beat_ratio, beat_result, beat_error, measured_at
    FROM line_auto_run_comparisons WHERE run_id = ${Number(run.id)} ORDER BY tts_id
  `;
  return { run, events, comparisons };
}

export async function startAutoRun(stem: string, options: { forceGenerate?: boolean } = {}) {
  const line = await loadLine(stem);
  if (!line) throw Object.assign(new Error("台词不存在"), { status: 404 });
  // 批次按稳定的stem去重，不按区域名、顺序或成品是否合格判断“跑过”。
  // 章节重命名/重排后重扫，也不能重复花费模型和TTS调用；待复核、失败、
  // 中断及正在执行的历史同样跳过。需重试时由界面forceGenerate=true明确发起。
  // 只读历史，不改旧状态、不清理产物，也不创建“跳过”的空运行记录。
  if (!options.forceGenerate) {
    const [previous] = await sql<{ id: string; selected_tts_id: string | null; status: string }[]>`
      SELECT id::text AS id, selected_tts_id::text AS selected_tts_id, status
      FROM line_auto_runs WHERE stem = ${stem}
      ORDER BY id DESC LIMIT 1
    `;
    if (previous) return {
      skipped: true as const, selectedTtsId: previous.selected_tts_id,
      reason: previous.status === "running" ? "已在自动运行，批量跳过" : "已经自动跑过，批量跳过；需重跑请在界面手动点击",
    };
  }
  const [running] = await sql<{ id: string; updated_at: string }[]>`
    SELECT id::text, updated_at FROM line_auto_runs
    WHERE stem = ${stem} AND status = 'running'
    LIMIT 1
  `;
  if (running) {
    if (Date.now() - new Date(running.updated_at).getTime() < STALE_MS) {
      throw Object.assign(new Error("这条已经在自动运行"), { status: 409 });
    }
    await finish(running.id, "failed", "上次运行中断", null);
  }
  // 批量入口保留人工锁；未锁的快速/手工成品必须同时过时间和比检查。
  // 完整线路已用裁后正文参考、短/慢句及动态时长豁免评判，不能拿完整原声比值重新推翻。
  // 只读现有结果，不建立空运行、不改父子归属；手点强制运行完全绕过此判断。
  const rejectedQuickResults: { ttsId: string; ratio?: number | null; reason: string }[] = [];
  if (!options.forceGenerate) {
    let referenceSeconds: Promise<number | null> | undefined;
    const results = await sql<{ id: string; audio_path: string; review_state: "candidate" | "locked" | "abnormal"; passed: boolean; complete_passed: boolean;
      spoken_text: string | null; tts_text: string; voice_gpu_key: string | null; workflow: string | null;
      start_s: number | null; end_s: number | null; dur_s: number | null; speech_s: number | null; jp_start_s: number | null; jp_end_s: number | null; jp_dur_s: number | null; jp_speech_s: number | null }[]>`
      SELECT v.id::text, v.audio_path, v.review_state, EXISTS (SELECT 1 FROM line_auto_runs r WHERE r.selected_tts_id=v.id AND r.status='passed') AS passed,
        EXISTS (SELECT 1 FROM line_auto_runs r WHERE r.selected_tts_id=v.id AND r.status='passed' AND r.reference_audio_path IS NOT NULL) AS complete_passed,
        v.spoken_text,v.tts_text,v.voice_gpu_key,v.conversion_meta->>'workflow' AS workflow,
        v.start_s,v.end_s,v.dur_s,v.speech_s,m.jp_start_s,m.jp_end_s,m.jp_dur_s,m.jp_speech_s
      FROM line_tts_versions v LEFT JOIN line_meta m ON m.stem=v.stem
      WHERE v.stem=${stem} AND v.status='ready' AND v.audio_path IS NOT NULL
        AND v.review_state <> 'abnormal'
        AND (v.parent_tts_id IS NULL OR v.review_state = 'locked')
      ORDER BY (v.review_state = 'locked') DESC,v.id DESC
    `;
    for (const row of results) {
      if (row.review_state === "abnormal") continue;
      const completePassed = row.passed && (row.complete_passed || row.voice_gpu_key === "jp-lock");
      const suitable = row.review_state === "locked" || completePassed || quickTimingPass(
      { start: row.jp_start_s, end: row.jp_end_s, dur: row.jp_dur_s, speech: row.jp_speech_s },
      { start: row.start_s, end: row.end_s, dur: row.dur_s, speech: row.speech_s }, line.dialogue_mode === "field",
      );
      if (!suitable) continue;
      try { if (!(await stat(dataFile(row.audio_path))).size) continue; } catch { continue; }
      // 整句降级是独立的待人工线路，本来就无法可靠校字/计算正文比；保留既有复用策略。
      // 旧quick-pick的passed没有裁后参考证据，必须重新检查，不能凭旧状态永久跳过。
      if (row.review_state !== "locked" && !completePassed && row.workflow !== "whole-line-fallback" && isPerformanceMode(line.dialogue_mode)) {
        try {
          const spoken = row.spoken_text || row.tts_text || "";
          const beats = await countBeats(line.text_jp || "", spoken, true);
          referenceSeconds ??= quickReferenceSpeechSeconds(stem);
          const check = quickBeatPass({ textJp: line.text_jp || "", spoken, beats, speechSeconds: await referenceSeconds });
          if (!check.pass) { rejectedQuickResults.push({ ttsId: row.id, ratio: check.ratio, reason: "已有成品未过比或短/慢句字数检查" }); continue; }
        } catch {
          rejectedQuickResults.push({ ttsId: row.id, reason: "已有成品比检查不可用，不能视为合格" });
          continue;
        }
      }
      return { skipped: true as const, selectedTtsId: row.id, reason: row.review_state === "locked" ? "已有人工锁定结果" : row.passed ? "已有自动通过结果" : "已有时间检查正常的成品" };
    }
  }
  const kind = isPerformanceMode(line.dialogue_mode) ? "performance" : "casual";
  const [run] = await sql<{ id: string }[]>`
    INSERT INTO line_auto_runs (stem, kind, status)
    VALUES (${stem}, ${kind}, 'running')
    RETURNING id::text
  `;
  // 仅新运行记录自己的前置检查，不篡改旧运行或音频；完整线路会按裁后参考再次复核。
  if (rejectedQuickResults.length) await log(run.id, "preflight-beat", "已有成品时间虽正常，但比检查未过，继续完整自动流程", { rejected: rejectedQuickResults }, "result");
  return { skipped: false as const, id: run.id, kind };
}

export async function executeAutoRun(runId: string, stem: string, options: { forceGenerate?: boolean } = {}) {
  return withLlmMetrics(runId, stem, () => runAutoRunModels({
    attempt: () => withTwoPartContext(() => executeAutoRunMeasured(runId, stem, options)),
    event: async (model, outcome) => {
      const name = model === "primary" ? "官方GLM 5.3" : "火山DeepSeek V4.1 Flash";
      await log(runId, outcome ? "model-stage-result" : "model-stage-start",
        outcome ? `${name}整轮${outcome.status === "passed" ? "通过" : "未通过"}` : `开始${name}完整工作流`,
        { model, ...(outcome ?? {}) }, "result");
    },
    canFallback: async () => {
      const locked = await sql`SELECT id FROM line_tts_versions WHERE stem=${stem} AND review_state='locked' LIMIT 1`;
      return locked.length === 0;
    },
    finish: outcome => finish(runId, outcome.status, outcome.error, outcome.selected, outcome.options),
  }));
}

async function executeAutoRunMeasured(runId: string, stem: string, options: { forceGenerate?: boolean }) {
  const line = await loadLine(stem);
  if (!line) {
    await finish(runId, "failed", "台词不存在", null);
    return;
  }
  const recovery: RunRecovery = { candidates: [] };
  try {
    const kind = isPerformanceMode(line.dialogue_mode) ? "performance" : "casual";
    await log(runId, "start", isSingingLine(line) ? "含音符的唱歌：直接锁定日文原声，歌词加括号，不调用ASR/TTS/模型" : pureShushuOriginal(line.text_jp, line.text_zh) ? "纯咻情绪，直接保留日文，不调用ASR/TTS/模型" : kind === "performance" ? "表演句，走 Seed-ASR" : "非表演句，走 Qwen-ASR", {
      kind, dialogue_mode: line.dialogue_mode,
    });
    await log(runId, "script-source", "从原中文字幕开始，不读取手动 TTS 文字或历史修订稿", {
      source: "lines.text_zh", text: line.text_zh,
    }, "result");
    // 已取消“原稿先直接Zero-shot试一批，表面合格就结束”的快速通道。
    // 无论手点或批量、force=true或false，只要真正创建了任务，立即进入对应完整工作流。
    // force仅影响启动前的历史/已有结果跳过规则；普通批处理的去重和人工锁保护仍保留。
    await log(runId, "workflow-entry", "自动运行直接进入完整工作流，不再先试原稿快速生成", { forceGenerate: options.forceGenerate === true, kind }, "result");
    if (isSingingLine(line)) {
      // 音符是唱歌标记，不限台词类型，优先于拟声/正常/降级工作流：完整日文直接锁定，歌词套括号。
      // 必须在任何Seed/Qwen/模型/TTS调用之前处理，forceGenerate=true也不能重新合成唱歌。
      await runOriginalJapanese(runId,line,await readFile(dataFile(`jp/${line.stem}.mp3`)),{
        workflow:"singing-original",reason:"原台词含音符：唱歌不处理，直接锁定完整日文原声",lock:true,
      });
    }
    else if (pureShushuOriginal(line.text_jp, line.text_zh)) {
      // 必须在任何Seed/Qwen/模型调用之前分流；不看ASR，也不把原声再合成一遍。
      await runOriginalJapanese(runId,line,await readFile(dataFile(`jp/${line.stem}.mp3`)),{
        workflow:"xiu-only-original",reason:"整句为重复咻／シュ情绪，纯机械保留完整日文原声及中文字幕",
      });
    }
    else if (kind === "performance") await runPerformance(runId, line, recovery);
    else await runCasual(runId, line, recovery);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log(runId, "fail", message, {}, "error");
    await finishWithFallback(runId, recovery, message);
  }
}

/** 斜体没有逐段/开口对时要求。只在TTS失败、核字失败或最终超长时再尝试；比单独失败待复核。 */
async function runItalicNatural(runId: string, line: LinePack, recovery: RunRecovery,
  jpWav: Buffer, plan: OnoPlan, reference: Buffer) {
  const jp = decodeWavMono(jpWav), target = jp.samples.length / jp.sampleRate;
  const bodyTarget=plan.preservedTail?preservedBodyDurationMs(plan.preservedTail)/1000:target;
  const promptPath = path.posix.join("tts", line.stem, `auto-run-${runId}-${currentChatModel() ?? "primary"}-italic-prompt.wav`);
  await mkdir(path.dirname(dataFile(promptPath)),{recursive:true});
  await writeFile(dataFile(promptPath),reference);
  await sql`UPDATE line_auto_runs SET reference_audio_path=${promptPath},reference_text_jp=${plan.jpSpeechText} WHERE id=${runId}`;
  const rules = await lexicon(), formatSubtitle = createAutoRunSubtitleFormatter();
  const net = measurePerformanceSpeakingTime({...decodeWavMono(reference),startS:0,endS:decodeWavMono(reference).samples.length/decodeWavMono(reference).sampleRate});
  const referenceBeat = await countBeats(plan.jpSpeechText,plan.cnTtsText).catch(()=>null);
  const reading = referenceBeat?.jpSpeech ?? referenceBeat?.jp;
  const ignoreBeat = Boolean(shortPerformancePolicy(plan.jpSpeechText)
    || slowPerformancePolicy(reading?.status==="ok" ? reading.mora : null,net?.speechSeconds??null));
  await log(runId,"workflow","斜体自然时长：不对开口、净发声和分段；最终不长于日文即通过时长；比单独失败不重试",{
    workflow:"italic-natural",targetSeconds:bodyTarget,originalTargetSeconds:target,ignoreBeat,retryReasons:["tts-error","text-error","final-too-long"],beatOnlyFailure:"manual-review",
  },"result");
  recovery.assemble = async candidate => {
    if(candidate.assembledId)return candidate.assembledId;
    if(!candidate.clip.audio_path)throw Error("斜体候选没有音频");
    const audio=await audioToMonoWav(await readFile(dataFile(candidate.clip.audio_path))),decoded=decodeWavMono(audio);
    if(!candidate.cutAxisRequested && needsChineseCutAxis(candidate.clip.tts_text,plan.onomatopoeia,plan.ambient)){
      candidate.cutAxisRequested=true;
      const axis=await asrSeedFile(candidate.clip.audio_path,{stem:line.stem,ttsId:candidate.clip.id});
      candidate.asr=axis.result;
    }
    const splice=await planSpliceAfterTts({onomatopoeia:plan.onomatopoeia,ambient:plan.ambient,speech:plan.speech,
      cnAsr:candidate.asr??{text:"",language:"zh-CN",durationMs:decoded.samples.length/decoded.sampleRate*1000,status:"unavailable",message:"无切片字轴",words:[],utterances:[],raw:null},
      cnAudio:decoded,cnTtsText:candidate.clip.tts_text});
    const mixed=fitItalicAudio(jpWav,audio,plan,splice.pieces,target);
    const id=await saveSplicedEdit(runId,line.stem,candidate.clip.id,mixed.audio,plan,splice.pieces,{
      workflow:"italic-natural",fit:mixed.fit,italic_policy:{version:1,onlyUpperBound:true,targetSeconds:target,finalPass:mixed.ok},
      beat_policy:{enabled:!ignoreBeat&&!candidate.normalSpeedBeat?.exempt,normal_speed:candidate.normalSpeedBeat??null},
    });
    await log(runId,"italic-final-length",`斜体 #${candidate.clip.id} → #${id}：最终${mixed.fit.actual_s.toFixed(3)}s / 日文${target.toFixed(3)}s，${mixed.ok?"未超长":"仍超长"}`,{sourceId:candidate.clip.id,selectedId:id,...mixed.fit},"result");
    if(!mixed.ok)throw new PartAssemblyError(`斜体处理后仍超长：${mixed.fit.actual_s.toFixed(3)}s > ${target.toFixed(3)}s`);
    candidate.assembledId=id;
    return id;
  };
  let script=plan.cnTtsText;
  if(!script.trim())throw Error("没有中文稿，无法合成");
  for(let round=1;round<=AUTO_RUN_MAX_ROUNDS;round++){
    const subtitle=await formatSubtitle(script),finalSubtitle=await formatSubtitle(plan.enabled?restorePerformanceSubtitle(plan.subtitleRestore,script):script);
    let clips:TtsClip[];
    try{
      clips=await generateClone(runId,line.stem,script,{promptPath,preservePromptAudio:true,alignStartS:null,subtitleText:subtitle,finalSubtitleText:finalSubtitle});
    }catch(error){
      await log(runId,"italic-tts-retry","斜体TTS失败，保留稿件重试",{round,error:String(error)},"error");
      if(round===AUTO_RUN_MAX_ROUNDS)throw error;
      continue;
    }
    const passed:RecoveryCandidate[]=[],review:RecoveryCandidate[]=[],tooLong:RecoveryCandidate[]=[];
    for(const candidate of rememberCandidates(recovery,clips,bodyTarget)){
      const clip=candidate.clip;
      const audio=await audioToMonoWav(await readFile(dataFile(clip.audio_path!))),timing=wavTiming(audio);
      const local=await asrQwen(clip),asr=localTtsAsr(local.text,local.raw,timing);
      candidate.asr=asr;
      const judged=await judgeSpokenText({spoken:clip.spoken_text,asr:asr.text,lexicon:rules,pronunciationText:clip.tts_text});
      candidate.reviewed=true;candidate.reason=judged.reason;
      candidate.hardIssueCount=judged.missing.length+judged.extra.length+judged.repeated.length+judged.unrelated.length+(judged.ok?0:1);
      candidate.pronunciationIssueCount=judged.pronunciationIssueCount;
      await log(runId,"judge",`斜体 #${clip.id} 核字${judged.ok?"通过":"不通过"}：${judged.reason}`,{ttsId:clip.id,ok:judged.ok,reason:judged.reason},"think");
      if(!judged.ok)continue;
      const beat=await countBeats(plan.jpSpeechText,clip.spoken_text).catch(()=>null);
      candidate.normalSpeedBeat=measureNormalSpeedBeatExemption(decodeWavMono(audio),clip.spoken_text,beat?.cn.han);
      const beatCheck=ignoreBeat||candidate.normalSpeedBeat.exempt?{enabled:false,pass:true,ratio:null,deviation:0}:checkAutoBeat(beat,plan.jpSpeechText);
      candidate.beatDeviation=beatCheck.deviation;
      await sql`UPDATE line_tts_versions SET conversion_meta=COALESCE(conversion_meta,'{}'::jsonb)||${sql.json({italic_policy:{version:1,onlyUpperBound:true,targetSeconds:target,textPass:true},beat_policy:beatCheck,normal_speed_beat:candidate.normalSpeedBeat})} WHERE id=${clip.id}`;
      await log(runId,"beat",`斜体 #${clip.id} 比${beatCheck.enabled?beatCheck.pass?"正常":"不合格，单独失败不重试":"豁免"}`,{ttsId:clip.id,...beatCheck},"result");
      let fits=true;
      try{await recovery.assemble(candidate);}catch(error){
        if(!(error instanceof PartAssemblyError))throw error;
        fits=false;candidate.hardIssueCount+=1;candidate.reason=String(error);tooLong.push(candidate);
      }
      const decision=italicCandidateDecision(true,fits,beatCheck.pass);
      if(decision==="passed")passed.push(candidate);
      if(decision==="review")review.push(candidate);
    }
    const choose=(items:RecoveryCandidate[])=>items.filter(x=>(x.pronunciationIssueCount??Infinity)===Math.min(...items.map(y=>y.pronunciationIssueCount??Infinity))).reduce((a,b)=>(a.durationDeviation??Infinity)<=(b.durationDeviation??Infinity)?a:b);
    if(passed.length){const chosen=choose(passed);await finish(runId,"passed",null,chosen.assembledId!);return;}
    if(review.length){const chosen=choose(review);await finish(runId,"failed","斜体核字、最终总长通过，但比不合格或不可用；保留候选待复核，不因比单独重试",chosen.assembledId!,{noModelRetry:true});return;}
    if(round===AUTO_RUN_MAX_ROUNDS)break;
    if(tooLong.length){
      const context=await loadDialogueContext(line.stem);
      const messages=[{role:"system" as const,content:"",promptKey:"rewrite.italic-ceiling.system",promptValues:{}},
        {role:"user" as const,content:"",promptKey:"rewrite.italic-ceiling.input",promptValues:{input_json:JSON.stringify({speaker:line.speaker,originalChinese:line.text_zh,japanese:line.text_jp,english:line.text_en,current:script,before:context.before,after:context.after,targetSeconds:bodyTarget,failures:tooLong.map(x=>({id:x.clip.id,reason:x.reason}))})}}];
      try{const result=await rewriteChat(messages,.3,"italic-duration-rewrite",3,{stem:line.stem});const parsed=parseJsonObject(result.content);
        if(typeof parsed.text!=="string"||!spokenCharacters(parsed.text))throw Error("斜体缩稿为空");
        script=parsed.text;
      }catch(error){await log(runId,"italic-rewrite","超长缩稿不可用，保留本轮稿重试TTS",{error:String(error)},"error");}
      await log(runId,"italic-retry","处理后超长，下一轮只尝试自然缩短正文",{round,script},"result");
    }else await log(runId,"italic-retry","本轮未通过核字，保持当前稿重新TTS",{round},"result");
  }
  await finishWithFallback(runId,recovery,"斜体三轮TTS未通过核字或最终总长上限，保留候选待复核");
}

async function runCasual(runId: string, line: LinePack, recovery: RunRecovery) {
  if (line.subtitle_italic) {
    await runWholeLineFallback(runId, line, recovery, await audioToMonoWav(await readFile(dataFile(`jp/${line.stem}.mp3`))), "斜体自然时长流程");
    return;
  }
  await log(runId, "workflow", "工作流：普通对话流程", { workflow: "casual" }, "result");
  // 普通对话仍先校字、择优，最后才检查实际波形是否适用两端/三段对话对齐。
  // 完整JP使用500ms、中文使用250ms分隔；两边必须同为2段或3段，不能按字幕标点猜段数。
  // 复用85%～115%逐段缩放、300ms警告/错误、250ms最小间隔和三段中段居中规则。
  // 不适用则保留原候选；已命中但不能合理对齐则待复核，不能整体变速掩盖错误。
  // 这里不调用ASR/模型、不改台词、不切情绪；只编辑最终选中稿，兜底择优也复用这一入口。
  recovery.assemble = async (candidate) => {
    if (candidate.assembledId) return candidate.assembledId;
    const jpFile = await readFile(dataFile(`jp/${line.stem}.mp3`)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!jpFile || !candidate.clip.audio_path) return candidate.clip.id;
    const jp = await audioToMonoWav(jpFile);
    const cn = await audioToMonoWav(await readFile(dataFile(candidate.clip.audio_path)));
    const aligned = alignZeroShotParts(cn, jp);
    if (!aligned) {
      await log(runId,"casual-final-alignment","最终波形未同时符合两段/三段，保留原候选",{ttsId:candidate.clip.id},"result");
      return candidate.clip.id;
    }
    const required = aligned.meta.requiredParts!;
    await log(runId,"casual-final-alignment",`普通对话最终编辑：${required===3?"三段对话工作流":"两端对话工作流"}，逐段缩放后对齐总时长`,{ttsId:candidate.clip.id,...aligned.meta},"result");
    if (!aligned.meta.pass) throw new PartAssemblyError(aligned.meta.reason || "普通对话逐段对齐不合格");
    const actual = decodeWavMono(aligned.audio), reference = decodeWavMono(jp);
    const target = reference.samples.length/reference.sampleRate;
    const actualS = actual.samples.length/actual.sampleRate;
    if (!assemblyLengthPass(actualS,target) || !inspectFinal(aligned.audio,required,aligned.meta.splitRegions).pass)
      throw new PartAssemblyError("普通对话逐段编辑后总长或分段检查不合格");
    const plan: OnoPlan = {enabled:false,reason:"普通对话最终波形分段对齐",thinking:"",speech:[{startMs:0,endMs:target*1000}],onomatopoeia:[],ambient:[],cnTtsText:candidate.clip.tts_text,originalCnTtsText:line.text_zh||"",jpSpeechText:line.text_jp||"",subtitleRestore:subtitleRestorePlan(line.text_zh||"",line.text_zh||"")};
    const fit = {version:required===3?"three-parts-exact-assembly-v1":"two-parts-exact-assembly-v1",target,actual_s:actualS,wav_s:actualS,scales:{body:1},splitRegions:aligned.meta.splitRegions,gaps_s:aligned.meta.gapsSeconds};
    const id = await saveSplicedEdit(runId,line.stem,candidate.clip.id,aligned.audio,plan,[{src:"tts",startMs:0,endMs:null}],{workflow:"casual-part-alignment",auto_run_gap_alignment:aligned.meta,fit});
    candidate.assembledId=id;
    await log(runId,"splice",`普通对话 #${candidate.clip.id} 分段编辑成 #${id}，最终 ${actualS.toFixed(3)}s / 目标 ${target.toFixed(3)}s`,{sourceId:candidate.clip.id,splicedId:id,fit},"result");
    return id;
  };
  const rules = await lexicon();
  const passing: { clip: TtsClip; asr: string; reason: string; pronunciationNotes: string[] }[] = [];
  // 自动运行始终从游戏原中文字幕开始，不读取手动 TTS 输入框、历史 TTS 或锁定字幕。
  const script = line.text_zh || "";
  if (!script.trim()) throw new Error("没有中文稿，无法合成");
  for (let round = 1; round <= AUTO_RUN_MAX_ROUNDS; round += 1) {
    await log(runId, "tts", `第 ${round} 次合成`);
    const clips = await generateClone(runId, line.stem, script, { subtitleText: null });
    await log(runId, "tts", `合成 ${clips.length} 条`, { ids: clips.map((row) => row.id) }, "result");
    for (const candidate of rememberCandidates(recovery, clips, line.jp_dur_s)) {
      const { clip } = candidate;
      candidate.beatDeviation = 0;
      const asr = await asrQwen(clip);
      await log(runId, "asr", `#${clip.id} Qwen：${asr.text || "（空）"}`, { ttsId: clip.id, text: asr.text }, "asr");
      const judged = await judgeSpokenText({ spoken: clip.spoken_text, asr: asr.text, lexicon: rules, pronunciationText:clip.tts_text });
      Object.assign(candidate, {
        reviewed: true,
        hardIssueCount: judged.missing.length + judged.extra.length + judged.repeated.length + judged.unrelated.length,
        pronunciationIssueCount: judged.pronunciationIssueCount,
        reason: judged.reason,
      });
      await log(runId, "judge", judged.ok ? `#${clip.id} 字过关` : `#${clip.id} 字不过：${judged.reason}`, {
        ttsId: clip.id, ok: judged.ok, reason: judged.reason, thinking: judged.thinking,
        modelPass: judged.modelPass,
        missing: judged.missing, extra: judged.extra, repeated: judged.repeated, unrelated: judged.unrelated,
        pronunciationNotes: judged.pronunciationNotes, pronunciationIssueCount: judged.pronunciationIssueCount,
      }, "think");
      if (judged.ok) passing.push({ clip, asr: asr.text, reason: judged.reason, pronunciationNotes: judged.pronunciationNotes });
    }
    if (passing.length) break;
    if (round < AUTO_RUN_MAX_ROUNDS) {
      await log(runId, "retry", "字不过，再合成一次");
    }
  }
  if (!passing.length) {
    await log(runId, "fail", "三次都没把字念对", {}, "error");
    await finishWithFallback(runId, recovery, "三次都没把字念对");
    return;
  }
  const target = line.jp_dur_s;
  const chosen = fewestPronunciationIssues(passing).reduce((best, row) => {
    if (target == null || row.clip.dur_s == null) return best;
    if (best.clip.dur_s == null) return row;
    return Math.abs(row.clip.dur_s - target) < Math.abs(best.clip.dur_s - target) ? row : best;
  });
  await log(runId, "pick", `选 #${chosen.clip.id}，先选读音疑点最少，再取时长最接近日文`, {
    ttsId: chosen.clip.id, dur_s: chosen.clip.dur_s, jp_dur_s: target,
    pronunciationNotes: chosen.pronunciationNotes,
  }, "result");
  const selected = recovery.candidates.find(candidate=>candidate.clip.id===chosen.clip.id)!;
  await finish(runId, "passed", null, await recovery.assemble(selected));
}

async function pickPassedClip(
  runId: string,
  line: LinePack,
  jpAsr: SeedAsrResult,
  passed: ({ clip: TtsClip; asr: SeedAsrResult; paceRatio: number | null; pronunciationNotes: string[] } & CandidateSpeedMeasurements)[],
) {
  // 字与跨度合格之后，读音疑点少的优先。节奏模型只能在同分候选中挑，
  // 不能以节奏更好为由，把疑点更多的一条选回来。
  // 仍然先比较读音疑点；只有同等疑点的候选才比较两节的时序。
  const rhythmRank = rankByRhythm(fewestPronunciationIssues(passed));
  const best = rhythmRank.items;
  await log(runId,"two-parts-rhythm-rank","同等读音疑点下，按各段时长及开口位置排序，50ms内留给模型择优",rhythmRank.metrics,"result");
  await log(runId, "quality", `保留读音疑点最少的 ${best.length} 条候选`, {
    candidates: passed.map((row) => ({ ttsId: row.clip.id, pronunciationNotes: row.pronunciationNotes })),
    shortlisted: best.map((row) => row.clip.id),
  }, "result");
  if (best.length === 1) {
    await log(runId, "pick", `选 #${best[0].clip.id}`, { ttsId: best[0].clip.id }, "result");
    return best[0];
  }
  // 最终择优时重新读邻句锁定状态，避免使用数分钟前改稿阶段的旧上下文。
  const context = await loadDialogueContext(line.stem);
  await log(runId, "pick-context", "最终择优同时考虑前后文连贯性；邻句优先锁定中文，本句沿用原中文", {
    before: context.before, after: context.after, originalChinese: line.text_zh || "",
  }, "result");
  const picked = await pickRhythm({
    context: { speaker: line.speaker || "未知", originalChinese: line.text_zh || "", before: context.before, after: context.after },
    textJp: line.text_jp || "",
    jp: jpAsr,
    candidates: best.map((row) => ({
      ttsId: row.clip.id,
      spoken: row.clip.spoken_text,
      asr: row.asr,
      paceRatio: row.paceRatio,
      netRate: row.netRate, netSpeechSeconds: row.netSpeechSeconds, spokenSyllables: row.spokenSyllables,
      normalizedBeatRatio: row.normalizedBeatRatio, beatBand: row.beatBand,
      beatExempt: row.beatExempt, beatExemption: row.beatExemption,
    })),
  });
  await log(runId, "pick", `模型选 #${picked.ttsId}：${picked.reason}`, {
    ttsId: picked.ttsId, reason: picked.reason, thinking: picked.thinking,
  }, "think");
  return best.find((row) => row.clip.id === picked.ttsId) ?? best[0];
}

/** 共用原声保存：仅在已选定原声线路后调用；完整复制MP3并附原中文字幕。
 * 不切分、不转码、不拉伸、不调用TTS/中文ASR。只有明确含♪的唱歌分支自动锁定。
 * 进入条件由调用者明确记录：有官方字幕但Seed空，或无官方字幕且中文经模型判为全拟声。
 */
async function runOriginalJapanese(runId: string, line: LinePack, original: Buffer, route: { workflow: string; reason: string; lock?: boolean }) {
  await log(runId, "workflow", `工作流：保留日文原声；${route.reason}`, { workflow: route.workflow }, "result");
  const subtitle = route.lock ? singingSubtitle(line.text_zh || "") : twoLineSubtitle(line.text_zh || "");
  const label = subtitle || line.text_jp || "（日文原声）";
  const [record] = await sql<{ id: string }[]>`
    INSERT INTO line_tts_versions (
      stem, auto_run_id, speaker, voice_version_id, voice_gpu_key,
      tts_text, spoken_text, subtitle_text, jp_text_snapshot, game_zh_text_snapshot,
      duration_factor, emo_alpha
    ) VALUES (
      ${line.stem}, ${runId}, ${line.speaker}, NULL, ${"jp-lock"},
      ${label}, ${label}, ${subtitle}, ${line.text_jp}, ${line.text_zh}, ${1}, ${0}
    ) RETURNING id::text AS id
  `;
  const relative = path.posix.join("tts", line.stem, `${record.id}.mp3`);
  await mkdir(path.dirname(dataFile(relative)), { recursive: true });
  // 保存原始 MP3 字节，整句头尾及拟声保持原样，不使用前面解码的 WAV 重编码。
  await writeFile(dataFile(relative), original);
  await sql`
    UPDATE line_tts_versions v SET status = 'ready', audio_path = ${relative},
      audio_bytes = ${original.length}, start_s = m.jp_start_s, end_s = m.jp_end_s,
      dur_s = m.jp_dur_s, speech_s = m.jp_speech_s,
      conversion_meta = ${sql.json({ pipeline: "jp-lock", workflow: route.workflow, source: `jp/${line.stem}.mp3`, reason: route.reason })},
      completed_at = now(), error = NULL
    FROM line_meta m WHERE v.id = ${record.id} AND m.stem = v.stem
  `;
  if(route.lock)await sql.begin(async tx=>{
    await tx`SELECT stem FROM lines WHERE stem=${line.stem} FOR UPDATE`;
    await tx`UPDATE line_tts_versions SET review_state='candidate',used_at=NULL WHERE stem=${line.stem} AND review_state IN ('locked','abnormal')`;
    await tx`UPDATE line_tts_versions SET review_state='locked',used_at=now() WHERE id=${record.id} AND status='ready'`;
  });
  await log(runId, route.workflow, `${route.reason}；保存完整日文原声为 #${record.id}，附${route.lock?"括号歌词并锁定":"原中文字幕"}`, {
    selectedId: record.id, source: `jp/${line.stem}.mp3`, subtitleText: subtitle,
    skipTts: true, skipChineseAsr: true, skipSegmentation: true, skipRewrite: true,locked:!!route.lock,
  }, "result");
  // 原字幕直接附上，不再走最后补引号的模型调用；沿用统一结束逻辑登记主音频。
  await finish(runId, "passed", null, record.id, { preserveSubtitle: true });
}

/** 有官方日文字幕、但Seed正常返回空的旧线路保持：直接原声，不需要模型分类。 */
async function runEmptySeedOriginal(runId: string, line: LinePack, original: Buffer) {
  await runOriginalJapanese(runId, line, original, {
    workflow: "seed-empty-original", reason: "日文 Seed-ASR 返回空，直接保留完整日文原声及中文字幕",
  });
}

/** 无官方日文字幕的独立线路，优先于“Seed空直接原声”的旧规则。
 * ASR识别到什么，就作为本次临时日文原文/快照；为空也不编造，绝不写回lines.text_jp。
 * 模型判中文全拟声且ASR为空/也支持拟声→日文原声+中文；日/中任一有正文、冲突或失败→TTS三次。
 * 两条出口都必须产出音频，不能因为缺官方日文字幕就停止在待人工处理。
 */
async function runMissingJapaneseSubtitle(runId: string, originalLine: LinePack, recovery: RunRecovery,
  original: Buffer, jpWav: Buffer, asrText: string, seedError?: string) {
  const line = { ...originalLine, text_jp: asrText.trim() };
  await sql`UPDATE line_auto_runs SET reference_text_jp = ${line.text_jp} WHERE id = ${runId}`;
  await log(runId, "missing-jp-subtitle", "官方日文字幕为空，以Seed结果作为本次日文文本，判断中文全拟声及日文有无正文证据", {
    originalJapaneseSubtitle: originalLine.text_jp, japaneseTextSource: "seed-asr", japaneseText: line.text_jp,
    chineseSubtitle: line.text_zh, seedError: seedError ?? null,
  });
  let reason = "中文不是已确认的整句拟声";
  let decision: Awaited<ReturnType<typeof classifyMissingJapaneseSubtitle>> | null = null;
  try {
    decision = await classifyMissingJapaneseSubtitle(line.text_zh || "", line.text_jp);
    await log(runId, "missing-jp-subtitle", `模型判断原声是否可保留：${decision.kind}；${decision.reason}`, { decision }, "think");
    reason = `无官方日文字幕，日中联合判断为${decision.kind}：${decision.reason}`;
  } catch (error) {
    reason = `无官方日文字幕，中文拟声分类不可用：${error instanceof Error ? error.message : String(error)}`;
    await log(runId, "missing-jp-subtitle", reason, {}, "error");
  }
  if (decision?.kind === "onomatopoeia") {
    await runOriginalJapanese(runId, line, original, {
      workflow: "missing-jp-subtitle-original", reason: `官方日文字幕为空，中文全拟声且日文无明确正文证据：${decision.reason}`,
    });
    return;
  }
  await runWholeLineFallback(runId, line, recovery, jpWav, reason);
}

/** 两条独立降级入口共用的逐轮反馈合成。所有候选先落库再评估，异常仍保留可播放结果。
 * 完整日文用line_meta缓存；裁剪参考用本次reference_seed_asr，禁止拿官方字幕假装ASR。
 * 实测跨度负责最终选优，净发声（扣>=250ms波形静音）负责给模型估算字数。
 */
async function generateFeedbackCandidates(runId: string, line: LinePack, recovery: RunRecovery,
  initial: string, extra: NonNullable<Parameters<typeof generateClone>[3]>, reference: Buffer,
  subtitles?: (draft: string) => Promise<{ subtitleText: string; finalSubtitleText: string }>) {
  const timingOf = (audio: Buffer): FallbackTiming => {
    const timing = wavTiming(audio);
    const decoded = decodeWavMono(audio);
    const net = measurePerformanceSpeakingTime({ ...decoded, startS: timing.start, endS: timing.end });
    if (!(timing.speech > 0) || !(net && net.speechSeconds > 0)) throw new Error("降级参考或候选没有可测量发声");
    return { span: timing.speech, net: net.speechSeconds };
  };
  const target = timingOf(reference);
  const [row] = await sql<{ japanese: string }[]>`
    SELECT COALESCE(CASE WHEN r.reference_audio_path = ${extra.promptPath || ""}
      THEN r.reference_seed_asr->>'text' ELSE m.seed_asr->>'text' END, '') AS japanese
    FROM line_auto_runs r LEFT JOIN line_meta m ON m.stem = r.stem WHERE r.id = ${runId}
  `;
  const candidates: RecoveryCandidate[] = [];
  const format = createAutoRunSubtitleFormatter();
  await runFallbackFeedback({ original: initial, initial, japaneseAsr: row?.japanese || "", target,
    synthesize: async (draft, round) => {
      let captions: { subtitleText: string; finalSubtitleText: string };
      try {
        const body = subtitles ? null : await format(draft);
        captions = subtitles ? await subtitles(draft) : { subtitleText: body!, finalSubtitleText: body! };
      } catch (error) {
        // 分行模型失败只回退字幕布局，不得因此丢失本轮TTS机会；拟声恢复由调用方自身保护。
        await log(runId, "subtitle-layout", "降级字幕分行失败，保留正文并继续合成", { error: String(error) }, "error");
        if (subtitles) throw error;
        captions = { subtitleText: autoRunSubtitle(draft), finalSubtitleText: autoRunSubtitle(draft) };
      }
      const clips = await generateClone(runId, line.stem, normalizeScript(draft).ttsText, {
        ...extra, ...captions, feedbackRound: true, manualTemplates: true,
      });
      const saved = rememberCandidates(recovery, clips, null);
      candidates.push(...saved);
      const candidate = saved[0];
      if (!candidate?.clip.audio_path) throw new Error("本轮降级TTS未产生音频");
      const timing = timingOf(await audioToMonoWav(await readFile(dataFile(candidate.clip.audio_path))));
      candidate.durationDeviation = Math.abs(timing.span - target.span);
      candidate.paceDeviation = candidate.durationDeviation;
      await log(runId, "fallback-tts", `第${round}/3轮 #${candidate.clip.id}：发声${timing.span.toFixed(3)}秒 / 参考${target.span.toFixed(3)}秒`, {
        round, ttsId: candidate.clip.id, script: draft, target, timing, selection: "waveform-span",
      }, "result");
      return { value: candidate, timing };
    },
    rewrite: async (prompt, round) => {
      await log(runId, "fallback-rewrite", `第${round}轮改稿：建议约${prompt.suggestedCharacters ?? "未知"}字，仅供参考`, {
        round, suggestedCharacters: prompt.suggestedCharacters, messages: prompt.messages,
      });
      const response = await rewriteChat(prompt.messages, 0.4, "fallback-duration-rewrite");
      const parsed = parseJsonObject(response.content);
      if (typeof parsed.text !== "string") throw new Error("降级改稿没有返回台词");
      await log(runId, "fallback-rewrite", parsed.text, { round, reason: parsed.reason, thinking: response.thinking }, "think");
      return parsed.text;
    },
    onRewriteError: async (error, round) => { await log(runId, "fallback-retry", `第${round}轮服务异常，保留已有稿和音频继续`, {
      round, error: error instanceof Error ? error.message : String(error),
    }, "error"); },
  });
  return candidates;
}

/** 整句降级线路：日文Seed服务异常、字幕对齐/拟声分类失败，或无官方字幕且含正文。
 * 原稿TTS→实测发声→ASR日文参考改稿→再TTS，共三轮；不做中文ASR/校字/拟声猜切。
 * 全轮择优后只编辑一次，仍待人工复核；建议字数不影响合格判定。
 */
async function runWholeLineFallback(runId: string, line: LinePack, recovery: RunRecovery, jpWav: Buffer, reason = "日文字幕与 ASR 字轴无法可靠对齐", tailSource?: {tail:PreservedTail;original:Buffer;asr:SeedAsrResult}) {
  if (line.subtitle_italic) {
    const duration = decodeWavMono(jpWav).samples.length / decodeWavMono(jpWav).sampleRate;
    const plan: OnoPlan = {enabled:false, reason, thinking:"", speech:[{startMs:0,endMs:duration*1000}],
      onomatopoeia:[], ambient:[], cnTtsText:line.text_zh||"", originalCnTtsText:line.text_zh||"",
      jpSpeechText:line.text_jp||"", subtitleRestore:subtitleRestorePlan(line.text_zh||"",line.text_zh||"")};
    if (tailSource) plan.preservedTail = tailSource.tail;
    await runItalicNatural(runId,line,recovery,tailSource?.original ?? jpWav,plan,jpWav);
    return;
  }
  await log(runId, "whole-line-fallback", `工作流：整体 fallback（整句降级）；${reason}`, {
    reference: `jp/${line.stem}.mp3`, text: line.text_zh, skipChineseAsr: true,
    skipReview: true, skipRewrite: false, skipSegmentation: true,
  }, "result");
  const script = normalizeScript(line.text_zh || "").ttsText;
  let fallbackPrompt = `jp/${line.stem}.mp3`;
  if (tailSource) {
    fallbackPrompt = path.posix.join("tts",line.stem,`auto-run-${runId}-tail-body-fallback.wav`);
    await mkdir(path.dirname(dataFile(fallbackPrompt)),{recursive:true});
    await writeFile(dataFile(fallbackPrompt),jpWav);
    await sql`UPDATE line_auto_runs SET reference_audio_path=${fallbackPrompt},
      reference_text_jp=${tailSource.asr.text},reference_seed_asr=${sql.json(JSON.parse(JSON.stringify(tailSource.asr)))} WHERE id=${runId}`;
  }
  const candidates = await generateFeedbackCandidates(runId, line, recovery, script, {
    promptPath: fallbackPrompt, subtitleText: autoRunSubtitle(line.text_zh || ""),
    ...(tailSource ? {preservePromptAudio:true,layoutSlot:{start:wavTiming(jpWav).start,dur:line.jp_dur_s!,speech:wavTiming(jpWav).speech}} : {}),
  }, jpWav);
  const chosen = closestFallback(candidates);
  if (!chosen?.clip.audio_path) throw new Error("整句降级线路没有返回可播放音频");
  await log(runId, "whole-line-fallback", `生成 ${candidates.length} 条整句候选，按时长选择 #${chosen.clip.id} 进入最终编辑`, {
    ids: candidates.map((row) => row.clip.id), sourceId: chosen.clip.id,
    selection: "waveform-span", reviewed: false,
  }, "result");
  const ttsWav = await audioToMonoWav(await readFile(dataFile(chosen.clip.audio_path)));
  const target = line.jp_dur_s || decodeWavMono(jpWav).samples.length / decodeWavMono(jpWav).sampleRate;
  const plan: OnoPlan = {
    enabled: false, reason, thinking: "", speech: [{ startMs: 0, endMs: target * 1000 }],
    onomatopoeia: [], ambient: [], cnTtsText: chosen.clip.tts_text, originalCnTtsText: line.text_zh || "",
    jpSpeechText: line.text_jp || "", subtitleRestore: subtitleRestorePlan(line.text_zh || "", line.text_zh || ""),
  };
  const pieces: SplicePiece[] = [{ src: "tts", startMs: 0, endMs: null }];
  const bodyMixed = spliceMix(jpWav, ttsWav, plan, pieces, target);
  const restored = tailSource ? appendPreservedTail(tailSource.original,bodyMixed.audio,tailSource.tail) : null;
  const fullDuration = restored ? wavTiming(restored.audio).duration : 0;
  const mixed = restored ? {...bodyMixed,audio:restored.audio,fit:{...bodyMixed.fit,target:fullDuration,
    actual_s:fullDuration,wav_s:fullDuration,body_fit:bodyMixed.fit,preserved_tail:restored.metadata}} : bodyMixed;
  if (tailSource) plan.preservedTail = tailSource.tail;
  const selected = await saveSplicedEdit(runId, line.stem, chosen.clip.id, mixed.audio, plan, pieces, {
    fit: mixed.fit, workflow: "whole-line-fallback", manual_review_required: true,
    quality_review: "manual-required", fallback_reason: reason,
  });
  await log(runId, "whole-line-fallback", `整句 #${chosen.clip.id} 整体编辑成最终音频 #${selected}，待人工复核`, {
    sourceId: chosen.clip.id, selectedId: selected, fit: mixed.fit, reviewed: false,
  }, "result");
  await finish(runId, "failed", `${reason}；整句降级线路已产生成品，未经自动评判，待人工复核`, selected);
}

/** 当前稿降级入口：正常线路单稿三次重试后仍无台词。
 * 从本轮当前稿开始逐轮TTS/波形反馈改写，共三次；模型继续失败就沿用上一稿。
 * 使用处理后日文音频及其ASR文字，候选字幕逐轮恢复已确认拟声；最终择优编辑并待复核。
 */
async function runCurrentScriptFallback(runId: string, line: LinePack, recovery: RunRecovery,
  script: string, extra: NonNullable<Parameters<typeof generateClone>[3]>, target: number | null, reason: string, subtitles: (draft: string) => Promise<{ subtitleText: string; finalSubtitleText: string }>) {
  await log(runId, "current-script-fallback", "工作流：当前稿 fallback；改稿重试耗尽，从本轮台词进入三轮反馈改稿 TTS 线路", {
    script, reference: extra.promptPath, reason,
  }, "result");
  const reference = await audioToMonoWav(await readFile(dataFile(extra.promptPath || `jp/${line.stem}.mp3`)));
  const candidates = await generateFeedbackCandidates(runId, line, recovery, script, extra, reference, subtitles);
  const chosen = closestFallback(candidates);
  if (!chosen || !recovery.assemble) throw new Error("当前稿降级线路没有可编辑的音频");
  chosen.workflow = "current-script-fallback";
  await log(runId, "current-script-fallback", `合成 ${candidates.length} 条当前稿候选，按时长选择 #${chosen.clip.id}`, {
    ids: candidates.map((row) => row.clip.id), sourceId: chosen.clip.id, script, reviewed: false,
  }, "result");
  const selected = await recovery.assemble(chosen);
  await log(runId, "current-script-fallback", `最终音频 #${selected} 已保存，待人工复核`, { selectedId: selected }, "result");
  await finish(runId, "failed", `${reason}；当前稿反馈改稿 TTS 线路已产生成品，待人工复核`, selected);
}

/** 正常场景线路：日文可对齐且分类成功后，切分/制参考 → TTS/校字/时长/比 → 必要改稿。
 * 无可靠日文依据或分类失败转整句降级；单稿响应三次重试耗尽转当前稿降级；
 * 三轮都有可用稿却音频不合格，则按原规则在已有候选中择优兜底，不混用进入条件。
 */

async function runPerformance(runId: string, line: LinePack, recovery: RunRecovery) {
  setMeaningAnchor({japanese:line.text_jp||"",chinese:line.text_zh||""});
  const rules = await lexicon();
  const jpPath = path.posix.join("jp", `${line.stem}.mp3`);
  const jpFile = await readFile(dataFile(jpPath));
  const jpWav = await audioToMonoWav(jpFile);
  await log(runId, "asr", "Seed 听日文");
  let jpHit: Awaited<ReturnType<typeof asrSeedFile>>;
  try { jpHit = await asrSeedFile(jpPath, { stem: line.stem }); }
  catch (error) {
    const reason = `日文 Seed-ASR 不可用：${error instanceof Error ? error.message : String(error)}`;
    // 缺官方字幕时仍可独立判断中文全拟声；ASR失败不是“空识别即原声”的依据。
    if (!(line.text_jp || "").trim()) await runMissingJapaneseSubtitle(runId, line, recovery, jpFile, jpWav, "", reason);
    else await runWholeLineFallback(runId, line, recovery, jpWav, reason);
    return;
  }
  let jpAsr = jpHit.result;
  // 切片边界以实际解码长度为准；DB旧MP3时长可能差几毫秒，不能把文件尾误判为正文内部。
  let durationMs = Math.round(decodeWavMono(jpWav).samples.length / decodeWavMono(jpWav).sampleRate * 1000);
  await log(runId, "asr", jpHit.cached
    ? `日文（缓存）：${jpAsr.text || "（空）"}`
    : `日文：${jpAsr.text || "（空）"}`, {
    text: jpAsr.text, status: jpAsr.status, utterances: jpAsr.raw, cached: jpHit.cached, durationMs,
  }, "asr");
  // 无官方字幕优先走独立中文分类，不能让“Seed空”绕过中文是否有正文的判断。
  if (!(line.text_jp || "").trim()) {
    await runMissingJapaneseSubtitle(runId, line, recovery, jpFile, jpWav, jpAsr.text);
    return;
  }
  // 有官方字幕时，空识别优先于字幕对齐/拟声分类：直接提供完整日文原声。
  // 仅针对服务正常返回的空文本，服务异常仍由上方 catch 进入原有降级线路。
  if (!jpAsr.text.trim()) {
    await runEmptySeedOriginal(runId, line, jpFile);
    return;
  }
  let asrWords = jpAsr.words.length ? jpAsr.words : jpAsr.utterances.flatMap((row) => row.words);
  let decodedJp = decodeWavMono(jpWav);
  const preservedTail = locatePreservedTail({ ...decodedJp, textJp: line.text_jp || "", words: asrWords,
    blocks: missingAudioBlocks({ ...decodedJp, words: asrWords }) });
  if (preservedTail) {
    jpAsr = tailBodyAsr(jpAsr, preservedTail); asrWords = jpAsr.words;
    decodedJp = decodeWavMono(tailBodyAudio(jpWav, preservedTail)); durationMs = preservedBodyDurationMs(preservedTail);
    await log(runId,"preserved-tail","正文完整确认：头尾声音分别作为原声整体保留，不分类、不计正文时长，最终按原位置拼回",{
      ...preservedTail, bodyText:jpAsr.text, bodyWordCount:asrWords.length,
    },"result");
  }
  const fallback = (reason?: string) => runWholeLineFallback(runId,
    preservedTail ? {...line,jp_dur_s:preservedBodyDurationMs(preservedTail)/1000} : line, recovery,
    preservedTail ? tailBodyAudio(jpWav,preservedTail) : jpWav, reason,
    preservedTail ? {tail:preservedTail,original:jpWav,asr:jpAsr} : undefined);
  // 切片对象使用ASR自己的字幕与字轴，避免官方字幕的汉字/假名写法差异阻断定位。
  // 官方日文仍传给模型作语义依据，并用于参考正文/拍数；绝不将ASR误字回填字幕。
  let subtitleClauses = alignJapaneseClauses(jpAsr.text, asrWords);
  const conservativeSplit = splitAsrClausesByOriginalPauses({ ...decodedJp, textJp: line.text_jp || "",
    asrText: jpAsr.text, words: asrWords, clauses: subtitleClauses });
  subtitleClauses = conservativeSplit.clauses;
  if (conservativeSplit.splits.length) await log(runId, "asr-clause-conservative-split",
    "原日文分隔与至少1秒真实静音共同确认ASR漏切，先补切再分类拟声",
    { splits: conservativeSplit.splits, clauses: subtitleClauses }, "result");
  await log(runId, "asr-clauses", "以 ASR 字幕建立切片，官方字幕用于语义核对", {
    source: "seed-asr", asrText: jpAsr.text, originalTextJp: line.text_jp, clauses: subtitleClauses,
  });
  let missingFragment: ReturnType<typeof recoverMissingFragment> = null;
  let confirmedAmbient: ReturnType<typeof recoverCompleteTextAmbient> = null;
  let integratedInternalSound: { startMs: number; endMs: number } | null = null;
  const audioBlocks = missingAudioBlocks({ ...decodedJp, words: asrWords });
  // 漏识别补救不限头尾：只有一块独立有声缺口才询问模型；两块及以上直接降级。
  // 是否缺字幕、缺几块以及前后对应均由模型按语义判断，代码不再删首段猜缺文。
  if (audioBlocks.length > 1) {
    await fallback(`发现${audioBlocks.length}块未被字轴覆盖的声音，禁止猜测多块对应`);
    return;
  }
  if (audioBlocks.length === 1) {
    try {
      await log(runId, "missing-fragment", "发现唯一候选声音，请模型核对是否恰好缺一块对应字幕（句首/句中/句尾）", { audioBlocks });
      const decision = await classifyMissingFragment(line.text_jp || "", line.text_zh || "", jpAsr, audioBlocks);
      await log(runId, "missing-fragment", `模型判断：${decision.kind}；${decision.reason}`, { audioBlocks, decision }, "think");
      confirmedAmbient=recoverCompleteTextAmbient({decision,words:asrWords,blocks:audioBlocks,...decodedJp});
      const internal = internalAmbientEvidence({ ...decodedJp, words: asrWords }, audioBlocks[0]);
      if (internal && !internal.pass && decision.missing_text_blocks === 0 && decision.audio_blocks === 1
        && decision.kind !== "onomatopoeia" && !decision.matched_jp.trim() && !decision.matched_zh.trim()) {
        integratedInternalSound = internal.gap;
        await log(runId, "internal-sound-body", "句中声音未满足>500ms且两侧各≥150ms真实静音，归入正文整体，不提取或拼回", internal, "result");
      }
      if(confirmedAmbient)await log(runId,"missing-fragment-ambient","模型确认字幕完整，唯一字轴外声音按环境音处理，继续正常工作流",{decision,ambient:confirmedAmbient},"result");
      missingFragment = recoverMissingFragment({ decision, textJp: line.text_jp || "", textZh: line.text_zh || "", words: asrWords, blocks: audioBlocks, ...decodedJp });
      if (missingFragment) {
        subtitleClauses = missingFragment.subtitleClauses;
        await log(runId, "missing-fragment", "唯一缺失拟声与声音对应，波形确认切口，保留原声并继续正常线路", { ...missingFragment }, "result");
      }
    } catch (error) {
      await log(runId, "missing-fragment", "唯一片段补救不可用，进入整句降级线路", { error: error instanceof Error ? error.message : String(error) }, "error");
    }
    // 不确定/非拟声/多块缺文/切口不成立，都不能继续猜测，仍保证降级线路输出一条音频。
    if (!missingFragment && !confirmedAmbient && !integratedInternalSound) {
      await fallback("未能确认唯一缺失拟声与唯一声音缺口对应");
      return;
    }
  } else if (!subtitleClauses.length) {
    await fallback();
    return;
  }
  await log(runId, "ono", "模型切拟声和正文");
  // 自动场景与手动 TTS 稿独立。去拟声从原中文字幕出发，后续只延续本轮生成的稿。
  const sourceScript = line.text_zh || "";
  let plan: AmbientPolicyPlan;
  try {
    plan = await planOnomatopoeia({
      textJp: missingFragment?.japaneseBody ?? (line.text_jp || ""),
      textZh: missingFragment?.chineseBody ?? (line.text_zh || ""),
      ttsText: missingFragment?.chineseBody ?? sourceScript,
      textEn: line.text_en || "",
      durationMs,
      jpAsr,
      subtitleClauses: missingFragment?.bodyClauses ?? subtitleClauses,
      clauseSplitEvidence: missingFragment ? undefined : conservativeSplit.splits,
    });
  } catch (error) {
    // 分类服务未能给出可用结果，切换独立整句降级线路，仍生成最终编辑产物。
    await fallback(`拟声分类不可用：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (missingFragment) {
    // 正常分类只看左右正文；最终字幕仍从完整原中文恢复拟声，不能缩掉重复字。
    plan.onomatopoeia.push(missingFragment.fragment);
    plan.onomatopoeia.sort((a, b) => a.startMs - b.startMs);
    plan.enabled = true;
    plan.reason = `恢复唯一漏识别拟声「${missingFragment.fragment.text}」；${plan.reason}`;
    plan.subtitleRestore = subtitleRestorePlan(sourceScript, plan.originalCnTtsText);
  }
  const refined = refinePerformanceBoundaries({
    ...decodedJp, onomatopoeia: plan.onomatopoeia, subtitleClauses,
  });
  const segments = segmentPerformanceAudio({
    ...decodedJp,
    speech: [...plan.speech, ...(integratedInternalSound ? [integratedInternalSound] : [])],
    ambient: confirmedAmbient?[confirmedAmbient]:[],
    words: asrWords,
    onomatopoeia: refined.onomatopoeia,
    // 声学校正允许越过首字ASR点最多50ms；保护连续正文时使用已校正的共享边界，
    // 不再用原ASR起点把合法切口误当成“切进连续正文”。原字轴仍在日志中保留。
    subtitleClauses: refined.clauses,
  });
  plan.speech = segments.filter((span) => span.kind === "speech");
  plan.onomatopoeia = segments.filter((span) => span.kind === "onomatopoeia");
  // 仅保留有零缺文与独立切口证据的环境音，其他未对应声音不得自动删除。
  plan.ambient = segments.filter((span)=>span.kind==="ambient");
  // 已确认的短拟声也必须从参考中删除，不再用时长门槛绕过清理。
  plan = applyAmbientPolicy(plan);
  if (preservedTail) plan = {...plan,preservedTail,enabled:true};
  if (plan.ignoredAmbient?.length) await log(runId, "ambient-ignored",
    "环境音不超过450ms：忽略分类，原音仍整句用于克隆，不删除或单独拼回；情绪拟声不受影响",
    { maxDurationMs: IGNORED_AMBIENT_MAX_MS, ignoredAmbient: plan.ignoredAmbient }, "result");
  const unknown = segments.filter((span) => span.kind === "unknown");
  const segmentLabels = { speech: "正文", silence: "停顿", onomatopoeia: "拟声", ambient:"环境音", unknown: "待判定声音" };
  await log(runId, "segment", segments.map((span) => (
    `${segmentLabels[span.kind]} ${(span.startMs / 1000).toFixed(2)}–${(span.endMs / 1000).toFixed(2)}s`
  )).join("；"), {
    segments, subtitleClauses, acousticSubtitleClauses: refined.clauses,
    boundaryRefinements: refined.adjustments,
    silencePeakRatio: SEGMENT_SILENCE_RATIO, minSilenceMs: SEGMENT_MIN_SILENCE_MS,
    ambient: plan.ambient,
  }, "result");
  if (unknown.length || !plan.speech.length) {
    // 波形切分还有未知块（包括ASR与解码长度差造成的短尾）或没有可靠正文时，不能猜成环境音。
    // 此时尚未生成中文候选，抛错会导致“无音频”；必须走独立整句反馈降级，保留原始日文整体参考。
    await fallback(unknown.length
      ? "日文原声存在待判定声音，无法可靠切分" : "日文原声没有可确认的正文");
    return;
  }
  await log(runId, "ono", plan.enabled
    ? `切拟声：${plan.onomatopoeia.map((span) => `${(span.startMs / 1000).toFixed(2)}–${(span.endMs / 1000).toFixed(2)}s`).join("，") || "无"}；环境音：${plan.ambient.map((span) => `${(span.startMs / 1000).toFixed(2)}–${(span.endMs / 1000).toFixed(2)}s`).join("，") || "无"}；正文「${plan.cnTtsText}」`
    : `不切拟声：${plan.reason}`, {
    enabled: plan.enabled, reason: plan.reason, thinking: plan.thinking,
    speech: plan.speech, onomatopoeia: plan.onomatopoeia, ambient: plan.ambient, cnTtsText: plan.cnTtsText,
  }, "think");

  const bodyJpWav = preservedTail ? tailBodyAudio(jpWav,preservedTail) : jpWav;
  const pcm = parseWavPcm16(bodyJpWav);
  // 每条场景句都准备参考：删拟声/环境音，裁首尾静音，内部静音逐字节保留。
  // 不凭正文片段重建参考，也不再额外补 0.3s 或插入估算的停顿。
  const reference = buildSpeechReference(bodyJpWav, pcm, {...plan,preservedTail:undefined});
  // 拟声/环境音分类与后续硬分段使用同一证据：不把分类阶段漏掉的声音重新升级成正文。
  const referencePartsEvidence = speechChunks(reference.audio, TWO_PART_JP_GAP_S);
  const referenceEvidence = referenceWordEvidence({sampleRate:referencePartsEvidence.wave.sampleRate,
    chunks:referencePartsEvidence.chunks,kept:reference.kept,
    // 短环境音按既有政策留在参考里，但即便ASR写出了字，也不作为正文段数依据。
    words:asrWords.filter(word=>!plan.ignoredAmbient?.some(span=>(word.start+word.end)/2>=span.startMs && (word.start+word.end)/2<=span.endMs))});
  if ([2,3].includes(referencePartsEvidence.chunks.length)) await log(runId,"reference-word-evidence",
    referenceEvidence.pass ? "波形分段已通过原始ASR正文对应确认" : referenceEvidence.reason,referenceEvidence,"result");
  if (!referenceEvidence.pass) {
    await fallback(referenceEvidence.reason);
    return;
  }
  const promptTiming = wavTiming(reference.audio);
  const referenceTextJp = plan.jpSpeechText;
  // 拍数比豁免条件取“或”：日文正文8字以内，或者纯摩拉语速严格低于3拍/秒。
  // 这与中文绝对语速硬门槛独立：中文正文至少6个汉字才检查9音节/秒上限。
  // 语速只用已去掉拟声/环境音且裁过首尾的真实参考；长静音不参与分母。
  const speakingTime = measurePerformanceSpeakingTime({ ...decodeWavMono(reference.audio), startS: promptTiming.start, endS: promptTiming.end });
  const speechSeconds = speakingTime && speakingTime.speechSeconds > 0 ? speakingTime.speechSeconds : null;
  const referenceChunks = speechChunks(reference.audio, TWO_PART_JP_GAP_S);
  const readingRegions = [2,3].includes(referenceChunks.chunks.length)
    ? referenceChunks.chunks.map(part => ({startSeconds:part.start/referenceChunks.wave.sampleRate,endSeconds:part.end/referenceChunks.wave.sampleRate})) : undefined;
  const referenceReading = measureReadingSpan(decodeWavMono(reference.audio), readingRegions);
  const characterLimit = performanceCharacterLimit(referenceTextJp, speechSeconds);
  const shortLine = shortPerformancePolicy(referenceTextJp);
  let referenceBeats: BeatResult | null = null;
  try { referenceBeats = await countBeats(referenceTextJp, plan.cnTtsText, true); }
  catch (error) {
      // 测拍服务失败不能变成“慢速豁免”；维持普通检查，后续沿用已有失败/重试处理。
    await log(runId, "speech-rate", "日文摩拉数不可用，不启用慢速豁免", { error: error instanceof Error ? error.message : String(error) }, "error");
  }
  // 8字以内优先走无字数限制的短句线路，不能被慢速分支重新要求凑摩拉或字符上限。
  const speechReading = referenceBeats?.jpSpeech ?? referenceBeats?.jp;
  const slow = slowPerformancePolicy(speechReading?.status === "ok" ? speechReading.mora : null, speechSeconds);
  const slowLine = !shortLine && slow ? { ...slow, max: characterLimit.max } : null;
  // 仅超过8字的慢速句保留既有字符上限。
  const characterPolicy = slowLine ? { jpCharacters: spokenCharacters(referenceTextJp), min: 1, max: characterLimit.max } : null;
  const ignoreBeat = Boolean(shortLine || slowLine);
  // 正常线路的动态豁免：校字可靠且整轮实测明显偏短后保持开启，不能增字后又被比压回旧稿。
  // 短句/日文慢速沿用原有独立规则；此标志不改变它们的字符上限、波形检查口径。
  let durationBeatReference = false;
  let durationLine: DurationRewritePolicy | undefined;
  const enablePace = ignoreBeat || paceEnabled(referenceTextJp);
  // 本轮从原中文字幕去拟声后得到正文，后续改稿只继承本轮状态。
  let script = plan.cnTtsText;
  // 每轮字幕跟随对应候选，不能在最终择优时把最后一轮稿盖到早期候选上。
  const subtitlePlan = plan.subtitleRestore;
  if (!plan.enabled && subtitleRestorePlan(sourceScript, plan.cnTtsText).preserved.length) throw new Error("中文稿删除了拟声文字，但没有对应原声片段可拼回");
  let subtitleDraft = plan.cnTtsText;
  let subtitleText = plan.enabled ? autoRunSubtitle(subtitleDraft) : null;
  await log(runId, "subtitle-plan", "TTS 子音频保存正文字幕；最终拼接字幕恢复原声拟声后最多两行", {
    sourceSubtitle: line.text_zh, sourceScript, cleanBody: plan.cnTtsText, ...subtitlePlan,
  }, "result");
  if (!script.trim()) throw new Error("没有中文稿，无法合成");
  const promptPath = path.posix.join("tts", line.stem, `auto-run-${runId}-${currentChatModel() ?? "primary"}-prompt.wav`);
  await mkdir(path.dirname(dataFile(promptPath)), { recursive: true });
  await writeFile(dataFile(promptPath), reference.audio);
  await sql`UPDATE line_auto_runs SET reference_audio_path = ${promptPath}, reference_text_jp = ${referenceTextJp}
    WHERE id = ${Number(runId)} AND stem = ${line.stem}`;
  // 再识别实际送入 TTS 的 WAV，建立真实参考轴；不能用原声字轴减时长代替。
  if (line.subtitle_italic) {
    await runItalicNatural(runId,line,recovery,jpWav,plan,reference.audio);
    return;
  }
  const referenceHit = await asrSeedFile(promptPath, { stem: line.stem, referenceRunId: runId }, "ja-JP");
  const referenceAsr = referenceHit.result;
  if (!recognizedSpeechSpan(referenceAsr)) throw new Error("处理后的日文参考 ASR 没有有效时间轴，不能比较语速或节奏");
  await log(runId, "reference-asr", referenceHit.cached ? "处理后日文参考 ASR（缓存）" : "Seed 识别处理后的日文参考", {
    referencePath: promptPath, sha256: referenceHit.stored.sha256,
    text: referenceAsr.text, utterances: referenceAsr.raw, cached: referenceHit.cached,
  }, "asr");
  if (shortLine && !slowLine) await log(runId, "short-policy", `日文正文 ${shortLine.jpCharacters} 字：不检查拍数比，不设中文字数上下限或目标，按朗读跨度（包含段内停顿）检查：比例0.85–1.15或绝对偏差≤${SHORT_NET_SPEAKING_TOLERANCE_MS}ms即通过`, {
    ...shortLine, absoluteToleranceMs: SHORT_NET_SPEAKING_TOLERANCE_MS, characterLimit: null, referencePath: promptPath, referenceTiming: promptTiming,
  }, "result");
  await log(runId, "speech-rate", slowLine
    ? `日文正文 ${slowLine.moraPerSecond.toFixed(3)} 拍/秒，低于3：不检查拍数比；改稿中文尽量补到 ${slowLine.target} 字`
    : shortLine ? "日文按短句条件豁免拍数比；语速测量仅记录参考" : "日文未满足低于3拍/秒的可靠依据，保留普通拍数比检查", {
    jpMora: speechReading?.mora ?? null, speechSeconds,
    moraPerSecond: speechReading?.mora != null && speechSeconds ? speechReading.mora / speechSeconds : null,
    readingStatus: speechReading?.status ?? null, threshold: 3, ignoreBeat, slowLine,
    speakingTime, characterLimit: characterPolicy ? characterLimit : null, referencePath: promptPath,
  }, "result");
  const cloneExtra = {
    promptPath,
    preservePromptAudio: true,
    // 参考轴和游戏时间槽是两回事。需拼回拟声时先生成干净正文；
    // 没有拟声则仍让 clone 路由读取原游戏槽，不能因裁参考首尾而缩短最终资产。
    ...(plan.enabled ? {
      layoutSlot: { start: promptTiming.start, dur: promptTiming.duration, speech: promptTiming.speech },
      alignStartS: promptTiming.start,
    } : {}),
  };
  await log(runId, "reference", "参考只删拟声/环境音并裁首尾静音，句间静音原样保留", {
    promptPath, ttsText: script, timing: promptTiming,
    sourceFrames: reference.sourceFrames, outputFrames: reference.outputFrames,
    removedFrames: reference.removedFrames, trimmedLeadingFrames: reference.trimmedLeadingFrames,
    trimmedTrailingFrames: reference.trimmedTrailingFrames, sampleRate: pcm.sampleRate, kept: reference.kept,
  }, "result");
  recovery.assemble = async (candidate) => {
    if (candidate.assembledId) return candidate.assembledId;
    if (!candidate.clip.audio_path) return candidate.clip.id;
    const ttsWav = await audioToMonoWav(await readFile(dataFile(candidate.clip.audio_path)));
    const decoded = decodeWavMono(ttsWav);
    const ttsDurMs = Math.round(decoded.samples.length / decoded.sampleRate * 1000);
    // 校字和择优始终只用本地Qwen；选定后且确需中文多段切口，才取一次Seed字轴。
    // 这份字轴仅定位，不再用其文字重做校字；同一候选装配重试也不重复请求。
    if (!candidate.cutAxisRequested && needsChineseCutAxis(candidate.clip.tts_text, plan.onomatopoeia, plan.ambient)) {
      candidate.cutAxisRequested = true;
      try {
        const axis = await asrSeedFile(candidate.clip.audio_path!, { stem: line.stem, ttsId: candidate.clip.id });
        candidate.asr = axis.result;
        await log(runId, "splice-axis", `最终选定 #${candidate.clip.id}，仅为拼接获取中文字轴${axis.cached ? "（缓存）" : ""}`, { ttsId: candidate.clip.id, purpose: "splice-only", cached: axis.cached }, "asr");
      } catch (error) {
        await log(runId, "splice-axis", "选定音频中文字轴不可用，保留整段正文，不猜切口", { ttsId: candidate.clip.id, error: String(error) }, "error");
      }
    }
    // ASR 服务故障时保留正文整段，不按文字比例猜切口；产物明确待复核。
    const cnAsr = candidate.asr ?? {
      text: "", language: "zh-CN" as const, durationMs: ttsDurMs,
      status: "unavailable", message: "兜底无 ASR", words: [], utterances: [], raw: null,
    };
    const splice = await planSpliceAfterTts({
      onomatopoeia: plan.onomatopoeia, ambient: plan.ambient, speech: plan.speech,
      cnAsr, cnAudio: decoded, cnTtsText: candidate.clip.tts_text,
    });
    const mixed = assemblePreserved(jpWav, ttsWav, plan, splice.pieces, line.jp_dur_s || ttsDurMs / 1000, reference.audio, candidate.clip.conversion_meta?.auto_run_gap_alignment?.splitRegions);
    const id = await saveSplicedEdit(runId, line.stem, candidate.clip.id, mixed.audio, plan, splice.pieces, { fit: mixed.fit, boundaries: splice.boundaries, cutMethod: splice.cutMethod,
      // 主音频也带上逐段正确/警告状态，不能只有子候选才知道为什么还存在余差。
      ...(candidate.clip.conversion_meta?.auto_run_gap_alignment ? {auto_run_gap_alignment:candidate.clip.conversion_meta.auto_run_gap_alignment} : {}),
      ...((requiredSplit || plan.onomatopoeia.length>0) ? {two_parts_assembly:{requiredParts:requiredPartCount,status:"correct",exact_length:Math.abs(mixed.fit.actual_s-mixed.fit.target)<=1/decodeWavMono(mixed.audio).sampleRate,tolerance_seconds:ASSEMBLY_LENGTH_TOLERANCE_S,delta_seconds:mixed.fit.actual_s-mixed.fit.target,target_seconds:mixed.fit.target,actual_seconds:mixed.fit.actual_s}} : {}),
      beat_policy: { enabled: !(ignoreBeat || durationBeatReference || candidate.normalSpeedBeat?.exempt), normal_speed: candidate.normalSpeedBeat ?? null, exemption: candidate.normalSpeedBeat?.exempt ? "normal-cn-net-speed" : durationBeatReference ? "actual-short" : slowLine ? "slow" : shortLine ? "short" : null, durationLine, slowLine, character_limit: characterPolicy ? characterLimit : null },
      ...(candidate.workflow ? { workflow: candidate.workflow, manual_review_required: true, quality_review: "manual-required" } : {}),
    });
    candidate.assembledId = id;
    await log(runId, "splice", `选定正文 #${candidate.clip.id} 编辑成 #${id}，${plan.enabled ? "保留情绪原声并调整间隔" : requiredSplit ? "逐段缩放后填充间隔" : "整段拉伸"}，最终 ${mixed.fit.actual_s.toFixed(3)}s / 目标 ${mixed.fit.target.toFixed(3)}s`, {
      sourceId: candidate.clip.id, splicedId: id, fit: mixed.fit, ok: mixed.ok,
      boundaries: splice.boundaries, cutMethod: splice.cutMethod,
    }, "result");
    return id;
  };
  // 先装配验收再择优，缓存同一候选成品；失败的候选不能挤掉其他已可用稿。
  const validateAssembled = async (candidate: RecoveryCandidate) => {
    const splicedId = await recovery.assemble!(candidate);
    const [row] = await sql<{audio_path:string;conversion_meta:{fit?:{splitRegions?:import("./speech-segments").SpeechSplitRegion[]}}}[]>`SELECT audio_path,conversion_meta FROM line_tts_versions WHERE id=${splicedId}`;
    const audio = await readFile(dataFile(row.audio_path)), wave = decodeWavMono(audio), jp = decodeWavMono(jpWav);
    const check = inspectFinal(audio,requiredSplit && !plan.enabled ? requiredPartCount : false,row.conversion_meta?.fit?.splitRegions);
    const actual = wave.samples.length / wave.sampleRate, target = jp.samples.length / jp.sampleRate;
    if (!assemblyLengthPass(actual,target) || !check.pass) throw new PartAssemblyError("最终总长误差超过50ms或分段结构被破坏，升级错误");
    // 无原声拼片时直接复测最终正文；保留情绪原声时仍用对应正文的独立测量。
    const finalReading = !plan.enabled ? compareReadingSpans(referenceReading,
      measureReadingSpan(wave,requiredSplit?row.conversion_meta?.fit?.splitRegions:undefined),
      {low:PACE_LOW,high:PACE_HIGH,...(shortLine?{absoluteToleranceMs:SHORT_NET_SPEAKING_TOLERANCE_MS}:{}),partToleranceMs:300}) : null;
    if (finalReading && enablePace && !finalReading.pass) throw new PartAssemblyError("最终朗读跨度或对应分段未通过，升级错误");
    await sql`UPDATE line_tts_versions SET conversion_meta=COALESCE(conversion_meta,'{}'::jsonb)||${sql.json(JSON.parse(JSON.stringify({final_timing:{version:"reading-span-final-v2",pass:true,actualSeconds:actual,targetSeconds:target,toleranceSeconds:ASSEMBLY_LENGTH_TOLERANCE_S,...(finalReading?{reading:finalReading}:{})}})))} WHERE id=${splicedId}`;
    return {splicedId,finalCheck:check};
  };
  const formatSubtitle = createAutoRunSubtitleFormatter();
  const loggedSubtitleLayouts = new Set<string>();
  const prepareSubtitle = async (draft: string) => {
    try {
      const formatted = await formatSubtitle(draft);
      if (formatted !== autoRunSubtitle(draft) && !loggedSubtitleLayouts.has(draft)) {
        await log(runId, "subtitle-layout", "本地排成两行，暂存原稿标点，最终分行后再清行末", { source: draft, subtitle: formatted }, "result");
        loggedSubtitleLayouts.add(draft);
      }
      return formatted;
    } catch (error) {
      // 字幕分行服务失败不能阻断已经授权的音频生成；保留原文，并明确记录待检查原因。
      await log(runId, "subtitle-layout", "本地字幕分行失败，保留原文并继续生成音频", { error: error instanceof Error ? error.message : String(error), source: draft }, "error");
      return autoRunSubtitle(draft);
    }
  };
  const failNotes: string[] = [];
  // 二/三段正文线路硬门槛：参考确认段数后中文必须对应。无论总时长/拍数多合适都不能绕过。
  const requiredPartCount=countParts(reference.audio,TWO_PART_JP_GAP_S);
  const requiredSplit=[2,3].includes(requiredPartCount);
  // 拟声分类只决定保留/删除哪些声音，不能据此推断两段/三段工作流。
  // 等真实处理后参考按波形完成分段后才记录实际线路；后续若降级，降级入口会另记一次。
  await log(runId, "workflow", `工作流：${requiredPartCount === 2 ? "两段说话" : requiredPartCount === 3 ? "三段说话" : "普通流程"}；处理后日文参考检测到 ${requiredPartCount} 段正文${plan.enabled ? "（已去拟声/环境音）" : ""}`, {
    workflow: requiredSplit ? `${requiredPartCount}-part-speech` : "performance-normal",
    requiredPartCount, minReferenceGapMs: TWO_PART_JP_GAP_S * 1000,
    onomatopoeiaCount: plan.onomatopoeia.length, ambientCount: plan.ambient.length,
  }, "result");
  let ttsBatches = 0;
  const policyForBatch=(batch:number)=>bodyScriptPolicy(plan.cnTtsText,batch,requiredPartCount);
  let rhythmAttempts = 0;
  let originalPunctuationAttempts = 0;
  // 警告可用稿跨额外一轮保留；不能因为尝试改善反而丢掉已有答案。
  let polishAttempted = false;
  let polishValidationPending = false;
  let polishScriptPolicy: BodyScriptPolicy | undefined;
  let warningRetryUsed = false;
  const warningPool: Parameters<typeof pickPassedClip>[3] = [];
  const meaningContext = await loadRewriteContext(line.stem, sourceScript, referenceTextJp);
  setMeaningAnchor({japanese:line.text_jp||"",chinese:line.text_zh||"",earliestDialogue:meaningContext.before.slice(0,3).map(x=>({japanese:x.textJp,chinese:x.textZh}))});
  setReference(reference.audio, referenceAsr, referenceTextJp, plan);
  const rhythmHistory: unknown[] = [];
  const beatCache = new Map<string, { result: BeatResult | null; error: string | null }>();
  if (referenceBeats) beatCache.set(plan.cnTtsText, { result: referenceBeats, error: null });
  for (let round = 1; round <= AUTO_RUN_MAX_ROUNDS; round += 1) {
    // 短句前三批strict，第4批放开片内停顿；长句从首批按行定义大分片。
    // 以实际合成批次计数，结构重试round--不会把“第4批”倒退回去。音频硬门槛不变。
    const scriptPolicy=polishValidationPending ? polishScriptPolicy! : policyForBatch(ttsBatches+1);
    setBodyScriptPolicy(scriptPolicy);
    if(requiredSplit && !validBodyScript(script,requiredPartCount,scriptPolicy)){
      let repaired=false,lastError:unknown;
      for(let attempt=1;attempt<=3;attempt++)try{
        script=await repairTwoParts({stem:line.stem,script,textJp:referenceTextJp,textEn:line.text_en||"",referenceAudio:reference.audio,round,history:rhythmHistory,allowRewrite:requiredPartCount===3,feedback:(scriptPolicy==="lines" ? `请整理为${requiredPartCount}行，每行代表一个目标分片；保留并可调整行内逗号、句号、省略号等来控制时长和语气，禁止为凑唯一停顿删掉自然标点。只整理标点与分行，不改正文。` : `必须整理成${requiredPartCount}个语义部分，必须且只能有${requiredPartCount-1}处句中停顿。两段只调标点不改正文；三段允许忠实原意重写。每部分内部不得再插停顿。`)+(lastError ? "上次失败必须纠正："+String(lastError) : "")});
        subtitleDraft=script;repaired=true;break;
      }catch(error){lastError=error;await log(runId,"two-parts-single-pause","分片台词整理失败，重新请求",{attempt,error:String(error)},"error");}
      if(!repaired)throw lastError;
      await log(runId,"two-parts-single-pause",`朗读稿已按${scriptPolicy}协议整理为${requiredPartCount}个目标分片`,{script,scriptPolicy},"result");
    }
    ttsBatches++;
    await log(runId, "tts", `累计第${ttsBatches}批合成，常规第${round}轮${plan.enabled?"（无拟声/环境音正文）":""}`,{batch:ttsBatches,round,scriptPolicy,polish:polishValidationPending});
    const bodySubtitle = await prepareSubtitle(subtitleDraft);
    if (plan.enabled || subtitleText !== null || bodySubtitle !== sourceScript.trim()) subtitleText = bodySubtitle;
    const finalSubtitleText = plan.enabled
      ? await prepareSubtitle(restorePerformanceSubtitle(subtitlePlan, subtitleDraft)) : subtitleText;
    const clips = await generateClone(runId, line.stem, script, {
      ...cloneExtra, subtitleText, finalSubtitleText, bodyScriptPolicy:scriptPolicy,
    });
    await log(runId, "tts", `合成 ${clips.length} 条`, {
      ids: clips.map((row) => row.id),
      autoDetect: clips.map((row) => ({ id: row.id, speech_pass: row.speech_pass })),
    }, "result");
    const passed: ({
      clip: TtsClip;
      asr: SeedAsrResult;
      paceRatio: number | null;
      pronunciationNotes: string[];
    } & CandidateSpeedMeasurements)[] = [];
    let textPassedCount = 0;
    let chineseSpeedOutOfBand = false;
    let rhythmMismatchCount = 0;
    let rhythmCorrectCount = 0;
    const punctuationEligible: unknown[] = [];
    const rhythmResults: {ttsId:string;actualParts:number;script:string}[] = [];
    let beatOutOfBand = false;
    const normalSpeedEvidence: { candidateId: string; script: string; rate: number; netSeconds: number; referenceSeconds: number; candidateSeconds: number }[] = [];
    let shortCharactersOutOfBand = false;
    const reliableWaveforms: { referenceSeconds: number; candidateSeconds: number; script: string; ttsId: string }[] = [];
    const roundRatios: number[] = [];
    const roundLengths: string[] = [];
    const roundSpans: { ttsId: string; jpSeconds: number; cnSeconds: number; ratio: number }[] = [];
    for (const candidate of rememberCandidates(recovery, clips, line.jp_dur_s)) {
      const { clip } = candidate;
      if (!clip.audio_path) continue;
      // 每个中文候选只用自部署Qwen校字，禁止逐候选调用收费Seed。
      // 中文时长来自实际保存音频波形，不伪造Qwen没有提供的字轴。

      const candidateAudio = await audioToMonoWav(await readFile(dataFile(clip.audio_path)));
      const savedTiming = wavTiming(candidateAudio);
      const candidateText = clip.spoken_text;
      let beat = beatCache.get(candidateText);
      if (!beat) {
        try { beat = { result: await countBeats(referenceTextJp, candidateText), error: null }; }
        catch (error) { beat = { result: null, error: error instanceof Error ? error.message : String(error) }; }
        beatCache.set(candidateText, beat);
      }
      const candidateNet = measurePerformanceSpeakingTime({...decodeWavMono(candidateAudio),startS:savedTiming.start,endS:savedTiming.end});
      const splitRegions=clip.conversion_meta?.auto_run_gap_alignment?.splitRegions;
      const readingChunks = requiredSplit && !splitRegions?.length ? speechChunks(candidateAudio, .25) : null;
      const candidateRegions = requiredSplit ? splitRegions?.length ? splitRegions : readingChunks!.chunks.map(part => ({startSeconds:part.start/readingChunks!.wave.sampleRate,endSeconds:part.end/readingChunks!.wave.sampleRate})) : undefined;
      const candidateReading = measureReadingSpan(decodeWavMono(candidateAudio), candidateRegions);
      const readingComparison = compareReadingSpans(referenceReading,candidateReading,{low:PACE_LOW,high:PACE_HIGH,
        ...(shortLine?{absoluteToleranceMs:SHORT_NET_SPEAKING_TOLERANCE_MS}:{}),partToleranceMs:300});
      // 对时/择优只看含段内停顿的朗读跨度；净发声仅用于绝对语速和慢速识别。
      // 按逐段绝对误差之和排序，避免一段长、一段短在总和中抵消。
      candidate.durationDeviation = readingComparison.parts.length
        ? readingComparison.parts.reduce((sum,part)=>sum+Math.abs(part.deltaMs),0)/1000 : null;
      const normalSpeedBeat = measureNormalSpeedBeatExemption(decodeWavMono(candidateAudio), candidateText, beat.result?.cn.han);
      candidate.normalSpeedBeat = normalSpeedBeat;


      const actualParts = countParts(candidateAudio, .25, splitRegions);
      rememberRhythm(clip.id,candidateAudio,clip.spoken_text,splitRegions);
      const partCheck=alignmentCheck(clip);
      const partsOk = (!requiredSplit || actualParts === requiredPartCount) && partCheck.pass;
      await log(runId,"two-parts-part-stretch","逐段85%～115%拉伸后检查300ms余差",{ttsId:clip.id,...partCheck},"result");
      if (!partsOk) rhythmMismatchCount++;
      else rhythmCorrectCount++;
      rhythmResults.push({ttsId:clip.id,actualParts,script:clip.spoken_text});
      await log(runId, "two-parts-two-parts", "正文分段：对应段数硬检查", {ttsId:clip.id,required:requiredSplit?requiredPartCount:null,actual:actualParts,pass:partsOk}, "result");
      const feedbackDraftId = createHash("sha256").update(candidateText).digest("hex");
      const regroup = clip.conversion_meta?.two_parts_regroup;
      const feedbackPartTexts = regroup?.consistent === true ? regroup.groups?.map(group =>
        group.map(index => regroup.segments.find(segment => segment.index === index)?.text ?? "").join("")) : undefined;
      const feedbackInput: AttemptInput = {draftId:feedbackDraftId,
        script:normalizeScript(script).spokenText===candidateText?script:candidateText,
        requiredChecks:["text",...(requiredSplit?["parts" as const]:[]),"length","beat"],
        measurement:{draftId:feedbackDraftId,audioId:clip.id,netRate:normalSpeedBeat.rate,
          hardSpeed:checkChineseSpeakingSpeed(candidateText,candidateNet?.speechSeconds??null,beat.result?.cn.han),
          ...(characterPolicy?{characters:{count:spokenCharacters(candidateText),min:characterPolicy.min,max:characterPolicy.max}}:{}),
          ...(requiredSplit?{parts:{required:requiredPartCount,actual:actualParts,texts:feedbackPartTexts,checks:"parts" in partCheck?partCheck.parts:[],boundaryPass:clip.conversion_meta?.two_parts_regroup?.consistent===false?false:undefined,layoutPass:partCheck.reason?.includes("无法让")?false:undefined}}:{}),
          length:{pass:clip.speech_pass===true,deltaSeconds:savedTiming.speech-(plan.enabled?promptTiming.speech:wavTiming(jpWav).speech)},
          beat:{enabled:!(ignoreBeat||durationBeatReference),ratio:beat.result?.normalizedRatio??null,...autoBeatBand(referenceTextJp)}}};
      if(!partsOk){
        // 分段归组已校验全文与本稿一致（含近音容忍）时复用结论；否则只认免费Qwen逐字一致。
        // 不把“啊/呀”等已确认的近音重新降级成待验证；未知结果仍不猜通过，更不据漏读盲目加字。
        try {
          if (clip.conversion_meta?.two_parts_regroup?.consistent === true || clip.conversion_meta?.two_parts_regroup?.textConsistent === true) {
            feedbackInput.measurement!.text={pass:true};
          } else {
            const local=await asrQwen(clip);
            const compact=(text:string)=>text.replace(/[\s\p{P}\p{S}]/gu,"");
            if(compact(local.text)===compact(candidateText))feedbackInput.measurement!.text={pass:true};
          }
        } catch(error) { await log(runId,"attempt-feedback","结构失败候选本地校字不可用，不推断字数方向",{ttsId:clip.id,error:String(error)},"error"); }
        await saveAttemptFeedback(runId,candidate,feedbackInput);

        // 结构已经不合格，无需再付费校字/判比；保留音频用于最后待人工兜底。
        candidate.reviewed=true;candidate.hardIssueCount=1000;candidate.reason="正文段数不符合";
        continue;
      }
      await log(runId,"asr",`#${clip.id} 结构通过，送本地 Qwen 校字`);
      const local=await asrQwen(clip);
      const asr = localTtsAsr(local.text, local.raw, savedTiming);
      candidate.asr = asr;
      await sql`UPDATE line_tts_versions SET conversion_meta = COALESCE(conversion_meta, '{}'::jsonb)
        || ${sql.json(JSON.parse(JSON.stringify({ local_asr: asr.raw })))}::jsonb WHERE id=${clip.id}`;
      // 沿用合成阶段对实际保存音频的 ±200ms 检查；ASR 跨度比合格不能覆盖它。
      // 这是选候选之前的条件，与选定后的最终编辑、拉伸结果无关。
      const lengthOk = clip.speech_pass === true;
      const targetSpeech = plan.enabled ? promptTiming.speech : wavTiming(jpWav).speech;
      const delta = savedTiming.speech - targetSpeech;
      // 无拟声时 clone 使用已存游戏槽指标，重新解码 MP3 的波形可能相差数十毫秒。
      // 合格状态与误差必须同取 clone 的检测结果，不能拿另一次测量的差值解释 speech_pass。
      const lengthError = clip.speech_score ?? Math.abs(delta);
      const lengthFact = `#${clip.id} 中文实际发声 ${savedTiming.speech.toFixed(3)}s，合成阶段时长误差 ${lengthError.toFixed(3)}s，要求 ±${LENGTH_SLACK_S}s：${lengthOk ? "过关" : "不过"}`;
      roundLengths.push(lengthFact);
      await log(runId, "length", lengthFact, { ttsId: clip.id, ok: lengthOk, candidateSpeechS: savedTiming.speech, referenceWaveformSpeechS: targetSpeech, waveformDeltaS: delta, lengthErrorS: lengthError, slackS: LENGTH_SLACK_S }, "result");
      // 参考与候选均用朗读跨度：段内自然停顿计时，段间留白另行装配。
      const waveformComparison = readingComparison;
      const comparison = ignoreBeat || enablePace ? waveformComparison : { ...waveformComparison, enabled: false, pass: true };
      const cnSpan = comparison.cnSpan;
      const ratio = comparison.spanRatio;
      rememberRoundSpeed({ttsId:clip.id,script:candidateText,paceRatio:ratio,
        netRate:normalSpeedBeat.rate,netSpeechSeconds:normalSpeedBeat.netSeconds,spokenSyllables:normalSpeedBeat.syllables,
        normalizedBeatRatio:beat.result?.normalizedRatio??null,beatBand:autoBeatBand(referenceTextJp),
        beatExempt:ignoreBeat||durationBeatReference||normalSpeedBeat.exempt,
        beatExemption:normalSpeedBeat.exempt?"normal-cn-net-speed":durationBeatReference?"actual-short":slowLine?"slow":shortLine?"short":null});
      const pace = { ok: comparison.pass };
      if (ratio != null) roundRatios.push(ratio);
      if (ratio != null && comparison.jpSpan && comparison.cnSpan) roundSpans.push({ ttsId: clip.id,
        jpSeconds: comparison.jpSpan.span / 1000, cnSeconds: comparison.cnSpan.span / 1000, ratio });
      candidate.paceDeviation = enablePace ? (ratio == null ? null : Math.abs(ratio - 1)) : 0;
      // 拍数“比”是另一种指标：用匹配本次参考的正文和该候选实际朗读稿计算。
      // 缓存只针对相同文字；不可用时记 null/error，不伪造 0；拍数和跨度分别检查。
      // 短句或实测慢速任一成立便豁免；比值只作诊断，不参与淘汰、改稿和兜底评分。
      const beatCheck = ignoreBeat || durationBeatReference || normalSpeedBeat.exempt ? { enabled: false, ratio: null, pass: true, deviation: 0 } : checkAutoBeat(beat.result, referenceTextJp);
      const chineseSpeed=checkChineseSpeakingSpeed(candidateText,candidateNet?.speechSeconds??null,beat.result?.cn.han);
      if(!chineseSpeed.pass)chineseSpeedOutOfBand=true;
      await sql`UPDATE line_tts_versions SET conversion_meta=COALESCE(conversion_meta,'{}'::jsonb)||${sql.json({chinese_speed:chineseSpeed,normal_speed_beat:normalSpeedBeat,beat_policy:{enabled:beatCheck.enabled,exemption:normalSpeedBeat.exempt?"normal-cn-net-speed":durationBeatReference?"actual-short":slowLine?"slow":shortLine?"short":null}})} WHERE id=${clip.id}`;
      await log(runId,"chinese-speed",`#${clip.id} 中文${chineseSpeed.hanCharacters}字，净语速${chineseSpeed.rate?.toFixed(3)??"不可测"}音节/秒：${!chineseSpeed.enabled?"不足6字豁免":chineseSpeed.pass?"过关":"超过9.0硬上限"}`,{ttsId:clip.id,...chineseSpeed},"result");
      const characters = characterPolicy ? checkShortCharacters(characterPolicy, candidateText) : null;
      if (characters && !characters.pass) shortCharactersOutOfBand = true;
      if (characters) await log(runId, "short-text", `#${clip.id} ${slowLine ? "慢速句" : "短句"}正文 ${characters.characters} 字，要求 ${characters.min}–${characters.max} 字${characters.pass ? "，过关" : "，不过"}`, { ttsId: clip.id, ...characters }, "result");
      candidate.characterDeviation = characters ? Math.max(characters.min - characters.characters, 0, characters.characters - characters.max) : 0;
      candidate.beatDeviation = beatCheck.deviation;
      if (beatCheck.enabled && !beatCheck.pass && beatCheck.deviation !== null) beatOutOfBand = true;
      await log(runId, "beat", normalSpeedBeat.exempt ? `#${clip.id} 中文净语速 ${normalSpeedBeat.rate!.toFixed(3)} 音节/秒在${normalSpeedBeat.low}–${normalSpeedBeat.high}内，拍数比 ${beat.result?.normalizedRatio?.toFixed(3) ?? "不可计算"} 忽略，不参与淘汰、改稿或评分` : durationBeatReference ? `#${clip.id} 拍数比 ${beat.result?.normalizedRatio?.toFixed(3) ?? "不可计算"} 仅供参考，不参与淘汰或评分` : !beatCheck.enabled ? `#${clip.id} ${durationBeatReference ? "实测偏短，拍数比仅供参考" : slowLine ? "日文慢速低于3拍/秒" : "日文短句"}，不计算拍数比`
        : `#${clip.id} 拍数比 ${beatCheck.ratio?.toFixed(3) ?? "不可计算"} ${beatCheck.pass ? "过关" : `不过，要求 ${autoBeatBand(referenceTextJp).low}–${autoBeatBand(referenceTextJp).high}`}`, {
        ttsId: clip.id, ...beatCheck, referenceRatio: beat.result?.normalizedRatio ?? null, error: beat.error, normalSpeedBeat, exemption: normalSpeedBeat.exempt ? "normal-cn-net-speed" : durationBeatReference ? "actual-short" : slowLine ? "slow" : shortLine ? "short" : null, slowLine,
      }, "result");
      await saveAutoRunComparison(runId, clip, referenceHit.stored, { path: clip.audio_path, sha256: createHash("sha256").update(await readFile(dataFile(clip.audio_path))).digest("hex") }, comparison, referenceTextJp, candidateText, beat);
      await log(runId, "asr", `#${clip.id} 本地 Qwen：${asr.text || "（空）"}`, {
        ttsId: clip.id, text: asr.text, status: asr.status, spanMs: cnSpan?.span ?? null,
        paceRatio: ratio, referencePath: promptPath, referenceSpanMs: comparison.jpSpan?.span ?? null,
        normalizedBeatRatio: beat.result?.normalizedRatio ?? null, beatVersion: beat.result?.version ?? null,
        provider: "qwen-local", waveform: asr.raw,
      }, "asr");
      const judged = await judgeSpokenText({ spoken: clip.spoken_text, asr: asr.text, lexicon: rules, pronunciationText:clip.tts_text });
      // 单独豁免比值不等于同时豁免“偏快且中文偏长”；沿用原正常区间和本句比值下限。
      const speedBeatPressure=fastLongPressure({netRate:normalSpeedBeat.rate,hardSpeed:chineseSpeed,evidenceVerified:partsOk&&judged.ok,
        beat:{ratio:beat.result?.normalizedRatio??null,low:autoBeatBand(referenceTextJp).low}});
      await sql`UPDATE line_tts_versions SET conversion_meta=COALESCE(conversion_meta,'{}'::jsonb)||${sql.json({speed_beat_pressure:speedBeatPressure})} WHERE id=${clip.id}`;
      Object.assign(candidate, {
        reviewed: true,
        hardIssueCount: judged.missing.length + judged.extra.length + judged.repeated.length + judged.unrelated.length + (chineseSpeed.pass ? 0 : 1) + (speedBeatPressure.triggered ? 1 : 0),
        pronunciationIssueCount: judged.pronunciationIssueCount,
        reason: judged.reason,
      });
      await log(runId, "judge", judged.ok ? `#${clip.id} 字过关` : `#${clip.id} 字不过：${judged.reason}`, {
        ttsId: clip.id, ok: judged.ok, reason: judged.reason, thinking: judged.thinking,
        modelPass: judged.modelPass,
        missing: judged.missing, extra: judged.extra, repeated: judged.repeated, unrelated: judged.unrelated,
        pronunciationNotes: judged.pronunciationNotes, pronunciationIssueCount: judged.pronunciationIssueCount,
      }, "think");
      feedbackInput.measurement!.text={pass:judged.ok,missing:judged.missing,extra:judged.extra,repeated:judged.repeated,unrelated:judged.unrelated};
      feedbackInput.measurement!.hardSpeed={enabled:chineseSpeed.enabled,pass:chineseSpeed.pass};
      feedbackInput.measurement!.characters=characters?{count:characters.characters,min:characters.min,max:characters.max}:undefined;
      feedbackInput.measurement!.readingLength=comparison.enabled?{pass:pace.ok,parts:comparison.parts,referenceSeconds:referenceReading?.readingSeconds,candidateSeconds:candidateReading?.readingSeconds,deltaSeconds:comparison.cnSpan&&comparison.jpSpan?(comparison.cnSpan.span-comparison.jpSpan.span)/1000:NaN}:undefined;
      await saveAttemptFeedback(runId,candidate,feedbackInput);
      if(partsOk && judged.ok && chineseSpeed.pass && !speedBeatPressure.triggered && lengthOk && pace.ok && (!characters || characters.pass) && beatCheck.enabled && !beatCheck.pass)
        punctuationEligible.push({ttsId:clip.id,script:clip.spoken_text,normalizedRatio:beatCheck.ratio,band:autoBeatBand(referenceTextJp)});
      if (judged.ok && partsOk && normalSpeedBeat.exempt) normalSpeedEvidence.push({candidateId:clip.id,script:candidateText,rate:normalSpeedBeat.rate!,netSeconds:normalSpeedBeat.netSeconds,referenceSeconds:referenceReading?.readingSeconds??0,candidateSeconds:candidateReading?.readingSeconds??0});
      if (judged.ok && partsOk) {
        textPassedCount += 1;
        reliableWaveforms.push({ referenceSeconds: referenceReading?.readingSeconds ?? 0, candidateSeconds: candidateReading?.readingSeconds ?? 0, script: clip.tts_text, ttsId: clip.id });
      }
      await log(runId, "pace", ignoreBeat
        ? `#${clip.id} ${slowLine ? "慢速句" : "短句"}朗读跨度比 ${ratio?.toFixed(3) ?? "不可计算"} ${pace.ok ? "过关" : "不过"}，要求比例0.85–1.15${shortLine ? `或绝对偏差≤${SHORT_NET_SPEAKING_TOLERANCE_MS}ms` : ""}`
        : enablePace
        ? (pace.ok ? `#${clip.id} 朗读跨度比 ${ratio?.toFixed(3)} 过关` : `#${clip.id} 朗读跨度比 ${ratio == null ? "没有跨度" : ratio.toFixed(3)} 不过`)
        : `#${clip.id} 日文短句，朗读跨度检查已豁免`, {
        ttsId: clip.id, enabled: enablePace, ok: pace.ok, ratio, metricVersion: comparison.metricVersion,
        deltaMs: comparison.deltaMs, absoluteToleranceMs: comparison.absoluteToleranceMs, ratioPass: comparison.ratioPass, absolutePass: comparison.absolutePass,
        referenceSpanMs: comparison.jpSpan?.span, candidateSpanMs: comparison.cnSpan?.span,
      }, "result");
      if (speedBeatPressure.triggered) {
        const message=`#${clip.id} 净语速${speedBeatPressure.rate!.toFixed(3)}高于正常区间${speedBeatPressure.normalLow}–${speedBeatPressure.normalHigh}，且比${speedBeatPressure.normalizedRatio!.toFixed(3)}低于${speedBeatPressure.beatLow}：优先精简后重新TTS，不因未超硬上限而直接通过`;
        failNotes.push(message);
        await log(runId,"fast-and-long",message,{ttsId:clip.id,...speedBeatPressure},"result");
      }
      if (partsOk && judged.ok && chineseSpeed.pass && !speedBeatPressure.triggered && lengthOk && pace.ok && beatCheck.pass && (!characters || characters.pass)) passed.push({ clip, asr, paceRatio: ratio, pronunciationNotes: judged.pronunciationNotes,
        // 原始同一候选的实测值直接随候选流转，不能用时长比猜净语速或把豁免的比改成1。
        netRate: normalSpeedBeat.rate, netSpeechSeconds: normalSpeedBeat.netSeconds, spokenSyllables: normalSpeedBeat.syllables,
        normalizedBeatRatio: beat.result?.normalizedRatio ?? null, beatBand: autoBeatBand(referenceTextJp),
        beatExempt: !beatCheck.enabled,
        beatExemption: normalSpeedBeat.exempt ? "normal-cn-net-speed" : durationBeatReference ? "actual-short" : slowLine ? "slow" : shortLine ? "short" : null,
      });
      else failNotes.push(`中文净语速${chineseSpeed.rate?.toFixed(3)??"不可测"}音节/秒：${chineseSpeed.pass?"过关":"超9.0，必须放慢或精简，不能加静音伪装"}；${lengthFact}；字:${judged.ok ? "过" : judged.reason} 朗读跨度:${pace.ok ? "过" : (ratio?.toFixed(3) ?? "无")} 拍数比:${normalSpeedBeat.exempt ? `中文净语速${normalSpeedBeat.low}–${normalSpeedBeat.high}，忽略` : durationBeatReference ? "实测偏短仅参考" : ignoreBeat ? (slowLine ? "慢速不检查" : "短句不检查") : `${beatCheck.ratio?.toFixed(3) ?? "无"}(${beatCheck.pass ? "过" : "不过"})`}${characters ? ` 字数:${characters.characters}(${characters.pass ? "过" : "不过"}，要求${characters.min}–${characters.max})` : ""}`);
    }
    // 润色只验证这一批；不再次进入结构重试或常规改稿，旧合格成品不混入新稿候选。
    if (polishValidationPending && !passed.length) {
      await finishWithFallback(runId,recovery,"等字数润色音频未通过完整验收");
      return;
    }
    if(warningPool.length && !polishValidationPending){
      for(const saved of warningPool)if(!passed.some(x=>x.clip.id===saved.clip.id))passed.push(saved);
    }
    // 本批结束后的所有改稿提示使用下一批协议，短句第3批失败后即可开始放开停顿。
    setBodyScriptPolicy(policyForBatch(ttsBatches+1));
    // 结构错误优先修标点，不让缺停顿造成的偏短进入增字反馈。
    // 三条全不符合结构才改断句；结构重试独立计数，不能消耗三轮语义改写预算。
    if (requiredSplit && !passed.length && rhythmMismatchCount > 0 && rhythmCorrectCount === 0) {
      rhythmAttempts++;
      rhythmHistory.push({attempt:rhythmAttempts,script,results:rhythmResults});
      await log(runId,"two-parts-pause-retry","分段结构或逐段时长未过：优先调整断句，必要时据分段余差自然调整正文",{round,rhythmAttempts,rhythmMismatchCount,maxBatches:10},"result");
      if(rhythmAttempts >= 10) break;
      // 逐段ASR证据不符/分组无法执行时，原稿重TTS，不拿缺字音频去改台词。
      if(clips.every(x=>x.conversion_meta?.two_parts_regroup?.consistent===false)){
        await log(runId,"two-parts-regroup-retry","逐段核对不一致或分组无效：保持当前台词直接重新TTS",{rhythmAttempts},"result");
        round--;continue;
      }
      try {
        const allowRewrite = allowBodyRewrite(ttsBatches, rhythmResults.map(x => x.actualParts), requiredPartCount);
        await log(runId,"two-parts-rewrite-permission",allowRewrite ? "允许调整正文和重组台词" : "尚未满3批且段数均不正确，本轮只调整标点和分段",{completedBatches:ttsBatches,nextBatch:ttsBatches+1,requiredParts:requiredPartCount,actualParts:rhythmResults.map(x=>x.actualParts),allowRewrite},"result");
        script = await repairTwoParts({stem:line.stem,script,textJp:referenceTextJp,textEn:line.text_en||"",referenceAudio:reference.audio,round,history:rhythmHistory,allowRewrite});
        subtitleDraft=script;
        await log(runId,"two-parts-pause-script","模型返回新朗读稿；最终字幕另行整理",{round,script},"result");
      } catch(error) {
        await log(runId,"two-parts-pause-script","断句返回不合法，保留原稿重试TTS",{error:String(error)},"error");
      }
      round--;
      continue;
    }
    // 原字、结构、校字和时长已合格但比未过，先给自然标点两次机会。
    // 比仍按原区间淘汰，不把本轮实验变成放宽比值的实验。
    if(requiredSplit && !passed.length && punctuationEligible.length && originalPunctuationAttempts < 2
      && script.replace(/[\p{P}\p{Z}\s]/gu,"") === plan.cnTtsText.replace(/[\p{P}\p{Z}\s]/gu,"")) {
      originalPunctuationAttempts++;
      await log(runId,"two-parts-original-punctuation","原字已过校字、长度和分段检查，仅比未过：先尝试自然断句，不增删字",{attempt:originalPunctuationAttempts,evidence:punctuationEligible},"result");
      try {
        const previousScript=script;
        const adjusted=await repairTwoParts({stem:line.stem,script,textJp:referenceTextJp,textEn:line.text_en||"",referenceAudio:reference.audio,round,history:rhythmHistory,
          feedback:"目前已有目标分片数、校字与实测时长合格的音频，只有拍数比不合格。保留原字，遵守当前scriptPolicy调整自然标点；按行模式须保留目标行数，允许片内轻微停顿调时长。不堆标点凑数。如果没有可行调整可原样返回。",beatEvidence:punctuationEligible});
        await log(runId,"two-parts-original-punctuation","原字标点尝试返回",{before:previousScript,script:adjusted,attempt:originalPunctuationAttempts},"result");
        rhythmHistory.push({type:"original-punctuation",script:adjusted,evidence:punctuationEligible});
        if(adjusted!==previousScript){script=adjusted;round--;continue;}
      } catch(error) {await log(runId,"two-parts-original-punctuation","标点尝试不可用，沿用原有改写规则",{error:String(error)},"error");}
    }
    if (!ignoreBeat && !durationBeatReference && clearlyShortSpeakingRound(reliableWaveforms)) {
      durationBeatReference = true;
      // 从这一刻起，所有历史候选的比偏差也清零，三轮后兜底不能再次按比把增字稿淘汰。
      for (const candidate of recovery.candidates) {
        candidate.beatDeviation = 0;
        // 全句策略切换也要同步历史退回原因，避免一边要求按时长增字，一边仍按旧比值要求减字。
        if (candidate.attemptInput?.measurement?.beat) {
          const feedback = structuredClone(candidate.attemptInput);
          feedback.measurement!.beat!.enabled = false;
          await saveAttemptFeedback(runId, candidate, feedback);
        }
      }
      beatOutOfBand = false;
      await log(runId, "beat-reference", "校字通过的候选朗读跨度均明显偏短：后续拍数比只作参考，改稿按朗读跨度调整自然节奏，必要时调整文字", {
        round, evidence: reliableWaveforms, minShortfallS: LENGTH_SLACK_S, maxLengthRatio: PACE_LOW,
        persistentForRun: true, skipBeatFiltering: true, skipBeatRanking: true,
      }, "result");
    }
    if (durationBeatReference && reliableWaveforms.length) {
      const best = reliableWaveforms.reduce((a, b) => Math.abs(a.candidateSeconds-a.referenceSeconds) <= Math.abs(b.candidateSeconds-b.referenceSeconds) ? a : b);
      durationLine = durationRewritePolicy(best.script, best.referenceSeconds, best.candidateSeconds);
    }
    if(passed.length && requiredSplit){
      const correct=passed.filter(x=>alignmentCheck(x.clip).status==='correct');
      if(correct.length)passed.splice(0,passed.length,...correct);
      else if(!polishValidationPending && !warningRetryUsed && passed.every(x=>alignmentCheck(x.clip).status==='warning')){
        warningRetryUsed=true;warningPool.push(...passed);
        await log(runId,"two-parts-warning-retry","仅有警告候选，保留现稿并额外请模型尝试一轮；失败仍选回可用稿",{ids:passed.map(x=>x.clip.id),extraRounds:1},"result");
        try{
          script=await repairTwoParts({stem:line.stem,script,textJp:referenceTextJp,textEn:line.text_en||"",referenceAudio:reference.audio,round,history:rhythmHistory,allowRewrite:true,
            feedback:"本轮只有警告，没有正确的可用候选：85%～115%缩放后各段仍有余差但均不超过300ms。请再改善一轮，优先自然断句与节奏，必要时微调表达，但不改变原始日中字幕的中心意思，不为几毫秒硬塞字。"});
          subtitleDraft=script;
        }catch(error){await log(runId,"two-parts-warning-retry","警告改善改稿失败，保留现稿再合成一次",{error:String(error)},"error");}
        round--;continue;
      }
    }
    for (let index=passed.length-1;index>=0;index--) {
      const item=passed[index], candidate=recovery.candidates.find(row=>row.clip.id===item.clip.id);
      if(!candidate)throw Error("待验收候选缺少恢复上下文");
      try {
        const verified=await validateAssembled(candidate);
        await log(runId,"final-assembly-precheck",`#${item.clip.id} 最终装配通过，可参与择优`,{ttsId:item.clip.id,...verified},"result");
      } catch(error) {
        if(!(error instanceof PartAssemblyError))throw error;
        passed.splice(index,1);
        const warningIndex=warningPool.findIndex(row=>row.clip.id===item.clip.id);if(warningIndex>=0)warningPool.splice(warningIndex,1);
        candidate.hardIssueCount=1000;candidate.reason=String(error);
        if(candidate.attemptInput){
          const feedback=structuredClone(candidate.attemptInput);
          feedback.requiredChecks=[...new Set([...feedback.requiredChecks,"assembly" as const])];
          feedback.measurement!.assembly={pass:false,failure:String(error).includes("250ms")?"cannot-fit-gaps":"unknown"};
          await saveAttemptFeedback(runId,candidate,feedback);
        }
        await log(runId,"final-assembly-precheck",`#${item.clip.id} 装配未过，保留其他可用候选`,{ttsId:item.clip.id,error:String(error)},"error");
      }
    }
    if(polishValidationPending && !passed.length){await finishWithFallback(runId,recovery,"润色候选最终装配未通过，保留已验收成品");return;}
    if (passed.length) {
      const chosen = await pickPassedClip(runId, { ...line, text_jp: referenceTextJp }, referenceAsr, passed);
      const selected = recovery.candidates.find(row=>row.clip.id===chosen.clip.id);
      if(!selected || !recovery.assemble)throw Error("选定候选缺少编辑上下文");
      let splicedId:string;
      try {
        // 成品仍尽量等长，正负50ms可接受；不能拿候选阶段的300ms警告容差代替成品门槛。
        const verified=await validateAssembled(selected);
        splicedId=verified.splicedId;
        await log(runId,"two-parts-final-structure","最终复查结构、总长和朗读跨度（容差50ms）",{...verified.finalCheck,toleranceSeconds:ASSEMBLY_LENGTH_TOLERANCE_S},"result");
      } catch(error) {
        if(!(error instanceof PartAssemblyError))throw error;
        if(selected.attemptInput){
          const feedback=structuredClone(selected.attemptInput);
          feedback.requiredChecks=[...new Set([...feedback.requiredChecks,"assembly" as const])];
          feedback.measurement!.assembly={pass:false,failure:String(error).includes("250ms")?"cannot-fit-gaps":"unknown"};
          await saveAttemptFeedback(runId,selected,feedback);
        }
        // 即便先前只是警告，拼不成等长成品也不可作为合格成品；清除可用池并反馈模型。
        selected.hardIssueCount=1000;selected.reason=String(error);selected.assembledId=undefined;
        const oldMeta=chosen.clip.conversion_meta?.auto_run_gap_alignment;
        if(oldMeta){oldMeta.status="error";oldMeta.pass=false;oldMeta.reason=String(error);}
        await sql`UPDATE line_tts_versions SET conversion_meta=COALESCE(conversion_meta,'{}'::jsonb)||${sql.json({speech_pass:false,two_parts_assembly:{status:"error",reason:String(error)},...(oldMeta?{auto_run_gap_alignment:oldMeta}:{})})} WHERE id=${chosen.clip.id}`;
        warningPool.splice(0,warningPool.length);rhythmAttempts++;
        await log(runId,"two-parts-assembly-error","无法组装等长：由警告/正确升级错误，重新请模型调整",{ttsId:chosen.clip.id,error:String(error),attempt:rhythmAttempts},"error");
        if (polishValidationPending) {
          await finishWithFallback(runId,recovery,"润色候选最终组装未通过："+String(error));
          return;
        }
        if(rhythmAttempts>=10)break;
        try{
          script=await repairTwoParts({stem:line.stem,script:chosen.clip.spoken_text,textJp:referenceTextJp,textEn:line.text_en||"",referenceAudio:reference.audio,round,history:rhythmHistory,allowRewrite:true,feedback:"最终组装失败，已升级错误："+String(error)+(requiredSplit?"。必须保留中心意思、恰好指定段数正文并让每处中间静音至少250ms，最终尽量与日文原音频等长，总长误差允许50ms。请据各段测量调整断句或表达。":"。情绪原声已保留，本轮只调整正文，不能重新加入情绪词，也不能把单段正文硬拆成两段。必须让最终组装总长与日文原音频的误差不超过50ms。")});
          subtitleDraft=script;
        }catch(rewriteError){await log(runId,"two-parts-assembly-rewrite","等长改稿失败，保留现稿继续尝试",{error:String(rewriteError)},"error");}
        round--;continue;
      }
      if (!polishAttempted) {
        polishAttempted = true;
        // 必须先保存并复查成品，润色失败才有已验证的回退，而非未经装配的正文候选。
        recovery.acceptedFinalId = splicedId;
        const [sourceMeta] = await sql<{conversion_meta:{body_script_policy?:BodyScriptPolicy;body_grouping_script?:string}}[]>`SELECT conversion_meta FROM line_tts_versions WHERE id=${chosen.clip.id}`;
        const policy = sourceMeta?.conversion_meta?.body_script_policy ?? scriptPolicy;
        const source = sourceMeta?.conversion_meta?.body_grouping_script ?? selected.attemptInput?.script ?? chosen.clip.tts_text;
        try {
          const polished = await polishAcceptedScript({stem:line.stem,sourceTtsId:chosen.clip.id,script:source,requiredParts:requiredPartCount,policy,
            textJp:line.text_jp||"",textZh:line.text_zh||"",textEn:line.text_en||""});
          await log(runId,"accepted-script-polish",polished.changed ? "合格稿逐段等字数润色，额外一批TTS完整复验" : "润色后保留原合格稿",{...polished,sourceId:chosen.clip.id,acceptedId:splicedId,sourceScript:source,requiredParts:requiredPartCount,scriptPolicy:policy},"result");
          if (polished.changed) {
            script=polished.script;subtitleDraft=script;polishScriptPolicy=polished.policy;polishValidationPending=true;
            round--;continue;
          }
        } catch(error) {
          await log(runId,"accepted-script-polish","润色不可用，保留原合格成品",{acceptedId:splicedId,error:String(error)},"error");
        }
      }
      if (polishValidationPending) await log(runId,"polish-validated","润色稿已通过核字、结构、时长、语速、拍数及最终组装复验",{originalId:recovery.acceptedFinalId,selectedId:splicedId},"result");
      await finish(runId, "passed", null, splicedId);
      return;
    }
    if (round === AUTO_RUN_MAX_ROUNDS) break;
    const shortDirection = ignoreBeat || durationBeatReference ? shortAudioDirection(roundRatios, PACE_LOW, PACE_HIGH, shortLine && referenceReading?.readingSeconds ? { referenceSeconds: referenceReading.readingSeconds, toleranceMs: SHORT_NET_SPEAKING_TOLERANCE_MS } : undefined) : null;
    if (shouldRetrySameScript(textPassedCount) && !chineseSpeedOutOfBand && !beatOutOfBand && !shortCharactersOutOfBand && !shortDirection) {
      // 全部有缺字等硬伤时，只淘汰候选并按原稿重试。不能随机漏读一次，
      // 就擅自改写本来正确的台词；但已实测拍数比越界说明稿长不合适，仍须改稿。
      // 短句整轮实测偏短/偏长也必须改字，不能因 ASR 失败绕过时长反馈。
      // 轮数上限仍是原来的三轮。
      await log(runId, "retry", "本轮校字全部未过，保留原稿重新合成", { round, failNotes });
      continue;
    }
    if (slowLine) {
      const conflict = slowMoraTargetConflict(slowLine, script, reliableWaveforms);
      if (conflict) {
        // 本次运行触发后不再恢复摩拉等字目标，防止下一稿又被拉回旧字数；上限仍保留。
        slowLine.durationDirection = conflict;
        await log(runId,"slow-mora-conflict",`慢速句字数与时长方向冲突，撤掉摩拉等字目标，按实测${conflict === "longer" ? "增字/延长" : "减字/缩短"}`,{direction:conflict,characters:spokenCharacters(script),jpMora:slowLine.jpMora,measurements:reliableWaveforms},"result");
      }
    }
    await log(runId, "rewrite", hasAttemptHistory() ? "按已有尝试和退回原因改一稿，再TTS实测" : durationBeatReference ? "实测偏短后的改稿：比仅参考，字数建议不强制，以发声时长为准" : slowLine ? slowLine.durationDirection ? "慢速句已撤掉摩拉等字目标，以实测发声时长改稿" : "日文慢速：忽略拍数比，中文字符数尽量补到纯摩拉数，并按实际发声长度改稿" : shortLine ? "短句按朗读跨度改写，不设中文字数限制，不按拍数比选稿" : beatOutOfBand ? "拍数比越界，五次改写正文并重新合成" : "校字有合格候选但语速或拍数比不可用，五次改写正文");
    const ctx = await loadRewriteContext(line.stem, script, referenceTextJp);
    let draft: Awaited<ReturnType<typeof rewriteFive>>;
    try {
      draft = await rewriteFive({
        speaker: line.name_zh || "",
        show: showEvidenceLabel(ctx.line.dialogue_evidence),
        textJp: referenceTextJp,
        textEn: line.text_en || "",
        original: plan.enabled ? plan.originalCnTtsText : (line.text_zh || ""),
        current: script,
        beats: ctx.beats,
        before: ctx.before,
        after: ctx.after,
        jpAsr: referenceAsr,
        failNotes,
        durationLine,
        attemptHistoryMode: hasAttemptHistory(),
        normalSpeedLine: normalSpeedEvidence.length ? normalSpeedEvidence[0] : undefined,
        extraUser: durationBeatReference ? [
          "本句已触发实测偏短豁免：拍数比只作参考，先前日志中的比过关/不过关不再是限制。",
          ...roundLengths,
          "发声偏短时增加自然、有意义的正文字符；偏长时精简。建议字数不是上限或下限，不要为比接近1删回旧稿。",
          "校字、实际音频时长和语速检查仍须通过，最终编辑只在选定之后进行。",
        ].join("\n") : slowLine ? [
          `日文刻意慢速：${slowLine.jpMora} 摩拉，正文发声 ${slowLine.speechSeconds.toFixed(3)} 秒，${slowLine.moraPerSecond.toFixed(3)} 拍/秒。不检查拍数比。`,
          slowLine.durationDirection ? `本轮正文 ${script} 共 ${spokenCharacters(script)} 字；程序已检测到字数与时长方向冲突，取消日文摩拉等字目标。请按本轮实际时长反馈自然增减字或调整断句，不要凑回日文拍数。` : `本轮当前正文 ${script} 共 ${spokenCharacters(script)} 字；请把中文正文补到接近或等于 ${slowLine.target} 字，不足时必须增加自然表达，不能按常规比值继续缩字。`,
          ...roundLengths,
          ...roundSpans.map(row => `#${row.ttsId} 日文正文朗读跨度 ${row.jpSeconds.toFixed(3)} 秒，中文 ${row.cnSeconds.toFixed(3)} 秒。`),
          `正文上限${slowLine.max}字（标点/空白不计），取max(日文非引号字符${characterLimit.jpLimitCharacters}, floor(净发声${speechSeconds?.toFixed(3)}秒×3.5)=${characterLimit.durationLimit})。优先保全语义，允许自然标点停顿，不能拆词或逐字堆标点。`,
          "仍须通过校字、候选时长及波形发声长度检查；不能加首尾静音或恢复拟声充长。标点作用需实际TTS验证；最终拉伸在选定候选后进行。",
        ].join("\n") : shortLine ? [
          "以下是裁剪后参考和已裁首尾静音的中文候选的波形实测。不设中文字数上下限或目标；已有自然准确的短句不要为凑字扩写。",
          `短句朗读跨度（包含段内停顿）满足中文/日文0.85–1.15，或中日绝对偏差不超过${SHORT_NET_SPEAKING_TOLERANCE_MS}ms，任一即通过；已在绝对容差内时，不要仅因比例越界缩短或扩写台词。`,
          ...roundSpans.map((row) => `#${row.ttsId}：日文朗读跨度 ${row.jpSeconds.toFixed(3)} 秒，中文朗读跨度 ${row.cnSeconds.toFixed(3)} 秒，中文/日文长度比 ${row.ratio.toFixed(3)}。`),
          shortDirection === "longer" ? "中文实际发声明显偏短：优先保留自然准确的表达，可调整自然断句和停顿；只有语义确有不足时才补全，不能为字数填充。"
            : shortDirection === "shorter" ? "中文实际发声明显偏长：下一稿应减少正文字符，保留原意和问句。"
              : "没有一致的时长方向，请结合逐条实测、原意和校字结果选择表达。",
          "鼓励自然语义停顿，不能拆词逐字堆标点、加首尾静音或恢复拟声充长；不按日文字数推算中文长度。",
        ].join("\n") : [
          ...roundLengths,
          ...roundSpans.map((row) => `#${row.ttsId} 日文正文朗读跨度 ${row.jpSeconds.toFixed(3)}s，中文 ${row.cnSeconds.toFixed(3)}s。`),
          "候选音频先按发声长度与日文相差不超过 200ms 检查，再选最好的一条进入编辑。",
          "如中文实测偏短，应增加汉字并补全自然表达；偏长则减少汉字。不能用静音或堆标点充长。",
          "最终编辑拉伸在选定后单独执行，不是本轮候选长度过关的依据。",
        ].join("\n"),
        slowLine: slowLine ?? undefined,
        shortLine: shortLine ?? undefined,
        measure: (text) => countBeats(referenceTextJp, text),
        onRetry: async (event) => {
          await log(runId, "rewrite-retry", `第 ${event.draftNumber} 稿返回失败，重试 ${event.nextAttempt - 1}/3`, event, "error");
        },
      });
    } catch (error) {
      if (!(error instanceof RewriteDraftUnavailableError)) throw error;
      // 只处理“模型没有给出可用稿且重试耗尽”；不得拿失败响应/半成品覆盖当前台词。
      await runCurrentScriptFallback(runId, line, recovery, script, {
        ...cloneExtra, subtitleText, finalSubtitleText,
      }, plan.enabled ? promptTiming.duration : line.jp_dur_s, error.message, async draft => ({
        subtitleText: await prepareSubtitle(draft),
        finalSubtitleText: await prepareSubtitle(plan.enabled ? restorePerformanceSubtitle(subtitlePlan, draft) : draft),
      }));
      return;
    }
    await log(runId, "rewrite", draft.text, {
      situation: draft.situation, problem: draft.problem, plan: draft.plan,
      risk: draft.risk, thinking: draft.thinking, candidates: draft.candidates, pickedInBand: draft.pickedInBand,
    }, "think");
    subtitleDraft = draft.text;
    subtitleText = autoRunSubtitle(draft.text);
    // 分行稿在送clone前保留原始行边界；clone内部负责把换行转为TTS标点。
    script = policyForBatch(ttsBatches+1)==="lines" ? draft.text : normalizeScript(draft.text, plan.enabled ? plan.cnTtsText : line.text_zh || undefined).ttsText;
  }
  const failReason = durationBeatReference ? "三次都没过校字、候选时长或语速（实测偏短后拍数比仅参考）" : slowLine ? "三次都没过校字、候选时长或慢速句有效发声长度（已忽略拍数比）" : shortLine ? "三次都没过校字、候选时长、短句有效发声长度" : "三次都没过校字、候选时长、语速和拍数比";
  await log(runId, "fail", failReason, { failNotes }, "error");
  await finishWithFallback(runId, recovery, failReason);
}
