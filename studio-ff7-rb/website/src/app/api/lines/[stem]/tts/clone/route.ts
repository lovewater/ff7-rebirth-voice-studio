import { withChatModel } from "@/lib/llm-model-context";
import type { BodyScriptPolicy } from "@/lib/two-part-script";
import { withLlmMetrics } from "@/lib/llm-metrics";
import { regroupTwoPartAudio, speechChunks, type RegroupMeta } from "@/lib/two-part-regroup";
import { TWO_PART_JP_GAP_S } from "@/lib/gap-only-align";
import { alignParts, alignZeroShotParts } from "@/lib/auto-run-part-alignment";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { autoRunSubtitle } from "@/lib/auto-run-subtitle";
import { sql } from "@/lib/db";
import { applyPronunciations, type Pronunciation } from "@/lib/pronounce";
import { DUR_OK_S, type Timing } from "@/lib/timing";
import { ensurePromptTailSilence, limitWavEdgeSilence, gpuJsonAt, matchPeak10Loudness, normalizeScript, TTS_URLS, wavTiming, withTts } from "@/lib/tts-gpu";
import { layoutSpeechWav, pickSpeechStretch, wavAlignmentTiming } from "@/lib/wav-stretch";
import { audioToMonoWav } from "@/lib/audio-splice";
import { resolvePromptRef } from "@/lib/prompt-refs";

export const dynamic = "force-dynamic";
export const maxDuration = 1200;

type TtsHealth = {
  model_version?: string;
  model_revision?: string;
  source_revision?: string;
  package_version?: string;
  precision?: string;
  device?: string;
};

function stemOk(stem: string) {
  return /^[\w.\-]+$/.test(stem);
}

function timingTarget(jp: Timing) {
  if (jp.speech != null && jp.speech > 0) return { key: "speech" as const, value: jp.speech };
  if (jp.dur != null && jp.dur > 0) return { key: "dur" as const, value: jp.dur };
  return null;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ stem: string }> },
) {
  const { stem } = await ctx.params;
  if (!stemOk(stem)) return NextResponse.json({ error: "bad stem" }, { status: 400 });
  const line = (
    await sql<{
      stem: string;
      speaker: string | null;
      text_jp: string | null;
      text_zh: string | null;
      jp_start_s: number | null;
      jp_end_s: number | null;
      jp_dur_s: number | null;
      jp_speech_s: number | null;
      dialogue_mode: string | null;
    }[]>`
      SELECT l.stem, l.speaker, l.text_jp, l.text_zh,
             m.jp_start_s, m.jp_end_s, m.jp_dur_s, m.jp_speech_s, m.dialogue_mode
      FROM lines l
      LEFT JOIN line_meta m ON m.stem = l.stem
      WHERE l.stem = ${stem}
    `
  )[0];
  if (!line) return NextResponse.json({ error: "台词不存在" }, { status: 404 });
  if (!line.speaker) return NextResponse.json({ error: "台词没有说话人" }, { status: 400 });
  const syncToJp = line.dialogue_mode !== "field";

  const body = (await req.json().catch(() => ({}))) as {
    ttsText?: string;
    bodyScriptPolicy?: BodyScriptPolicy;
    durationFactor?: number;
    promptStem?: string;
    promptLang?: "jp" | "cn";
    promptPath?: string;
    layoutSlot?: { start?: number; dur?: number; speech?: number };
    alignStartS?: number | null;
    preservePromptAudio?: boolean;
    manualTemplates?: boolean;
    feedbackRound?: boolean;
    autoRunId?: string;
    autoRunModel?: "primary" | "volcengine";
    subtitleText?: string | null;
    finalSubtitleText?: string | null;
  };
  // 在音频落库时登记归属，不等 HTTP 成功返回后再补写，避免异常时丢失工作流关系。
  const autoRunId = body.autoRunId == null ? null : String(body.autoRunId);
  if (body.autoRunModel !== undefined && !["primary", "volcengine"].includes(body.autoRunModel)) return NextResponse.json({ error: "无效的自动运行模型" }, { status: 400 });
  if (autoRunId != null) {
    if (!/^[1-9]\d*$/.test(autoRunId)) return NextResponse.json({ error: "无效的自动运行编号" }, { status: 400 });
    const [run] = await sql`SELECT id FROM line_auto_runs WHERE id = ${autoRunId} AND stem = ${stem} AND status = 'running'`;
    if (!run) return NextResponse.json({ error: "自动运行不存在、已结束或不属于这条台词" }, { status: 409 });
  }
  // 仅自动工作流携带已改写的字幕。普通手动合成沿用原来的确认流程。
  let subtitleText: string | null = null;
  if (autoRunId != null && body.subtitleText != null) {
    if (typeof body.subtitleText !== "string") return NextResponse.json({ error: "改稿字幕必须是文字" }, { status: 400 });
    try { subtitleText = autoRunSubtitle(body.subtitleText); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
  }
  let finalSubtitleText: string | null = null;
  if (autoRunId != null && typeof body.finalSubtitleText === "string") {
    try { finalSubtitleText = autoRunSubtitle(body.finalSubtitleText); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
  }
  let script: { ttsText: string; spokenText: string };
  try {
    script = normalizeScript(body.ttsText, line.text_zh ?? undefined);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
  const durationFactor = Number(body.durationFactor ?? 1);
  if (!Number.isFinite(durationFactor) || durationFactor < 0.5 || durationFactor > 2) {
    return NextResponse.json({ error: "时长倍率必须在 0.5 到 2.0 之间" }, { status: 400 });
  }
  const promptLang = body.promptLang === "cn" ? "cn" : "jp";
  const promptStem = typeof body.promptStem === "string" && /^[\w.\-]+$/.test(body.promptStem)
    ? body.promptStem
    : stem;
  const allowed = await resolvePromptRef(line.speaker, stem, promptStem, promptLang);
  if (!allowed.ok) {
    return NextResponse.json({ error: "请选择预设或邻近同人物台词作为参考音色" }, { status: 400 });
  }
  const promptNote = allowed.note;
  const dataRoot = path.join(process.cwd(), "data");
  let promptFile = path.join(dataRoot, promptLang, `${promptStem}.mp3`);
  let preservePromptAudio = false;
  if (typeof body.promptPath === "string" && /^(jp|cn|tts)\/[\w.\-\/]+$/.test(body.promptPath)) {
    const custom = path.join(dataRoot, body.promptPath);
    if (custom.startsWith(dataRoot + path.sep)) {
      promptFile = custom;
      preservePromptAudio = body.preservePromptAudio === true && custom.endsWith(".wav");
    }
  }
  const layoutSlot = body.layoutSlot && typeof body.layoutSlot === "object" ? body.layoutSlot : null;
  const slotStart = layoutSlot && Number.isFinite(Number(layoutSlot.start)) ? Number(layoutSlot.start) : line.jp_start_s;
  const slotDur = layoutSlot && Number.isFinite(Number(layoutSlot.dur)) ? Number(layoutSlot.dur) : line.jp_dur_s;
  const slotSpeech = layoutSlot && Number.isFinite(Number(layoutSlot.speech)) ? Number(layoutSlot.speech) : line.jp_speech_s;
  const alignStartS = body.alignStartS === null
    ? null
    : (Number.isFinite(Number(body.alignStartS)) ? Number(body.alignStartS) : (syncToJp ? slotStart : null));

  let prompt: Buffer;
  let gapReference: Buffer | null = null;
  let manualGapReference: Buffer | null = null;
  let healthByUrl: Map<string, TtsHealth>;
  try {
    const input = await readFile(promptFile);
    // 只改自动场景候选：用真实日文输入判断间隙，不把ensurePromptTailSilence补的静音算作目标。
    // 快速原稿、完整正文及整句fallback均由autoRunId归属验证，不影响真人Zero-shot。
    if (autoRunId != null && preservePromptAudio && body.feedbackRound !== true && syncToJp && promptLang === "jp" && promptStem === stem) {
      gapReference = await audioToMonoWav(input);
    }
    // 真人 Zero-shot：时序目标始终是当前句完整日文，而非所选的邻句/中文音色参考。
    // 完整原声的首尾和内部停顿都参与对齐；自动线路仍用已去情绪的正文参考。
    if (autoRunId == null && syncToJp) {
      const fullJapanese = await readFile(path.join(dataRoot, "jp", `${stem}.mp3`)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (fullJapanese) manualGapReference = await audioToMonoWav(fullJapanese);
    }
    // 自动运行已经删段、裁首尾并保留内部停顿，必须原样送入 TTS。
    // 这里不能再次补尾静音；其他未预处理的手动参考仍沿用原有准备流程。
    prompt = preservePromptAudio ? input : await ensurePromptTailSilence(input);
    const checks = await Promise.all(TTS_URLS.map(async (url) => {
      try {
        return [url, await gpuJsonAt<TtsHealth>(url, "/health", undefined, 30_000)] as const;
      } catch {
        return null;
      }
    }));
    healthByUrl = new Map(checks.filter((row): row is readonly [string, TtsHealth] => row !== null));
    if (!healthByUrl.size) throw new Error("配音机没有响应");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const langLabel = promptLang === "cn" ? "中文" : "日文";
    return NextResponse.json(
      { error: message.includes("ENOENT") ? `没有${langLabel}配音：${promptStem}` : `准备 zero-shot 失败：${message}` },
      { status: 400 },
    );
  }

  try {
    const lexicon = await sql<Pronunciation[]>`SELECT id, src, dst, note FROM pronunciations WHERE usage = 'reference'`;
    const ttsForGpu = applyPronunciations(script.ttsText, lexicon);
    const jpTiming: Timing = {
      start: slotStart,
      end: slotStart != null && slotSpeech != null ? slotStart + slotSpeech : line.jp_end_s,
      dur: slotDur,
      speech: slotSpeech,
    };
    // 对齐/拉伸使用当前参考的检测结果，不让旧缓存或日文微弱尖峰变成目标。
    // wavTiming及保存后的净语速测量保持原样，不能把对时滤波扩散到语速口径。
    const alignmentReference = gapReference ?? manualGapReference;
    if (syncToJp && alignmentReference) {
      const detected = wavAlignmentTiming(alignmentReference);
      jpTiming.start = detected.start; jpTiming.end = detected.end; jpTiming.speech = detected.speech;
    }
    const target = syncToJp ? timingTarget(jpTiming) : null;
    const promptB64 = prompt.toString("base64");
    const liveUrls = [...healthByUrl.keys()];
    // 只有已验证归属的降级工作流可单轮合成；普通手动及正常自动线路仍生成原有三候选。
    // 此处不拉伸、不补时间槽，实测反馈必须来自真实合成发声，最终选定后再整体编辑。
    const feedbackRound = autoRunId != null && body.feedbackRound === true;
    const settled = await Promise.allSettled(
      (feedbackRound ? [0] : [0, 1, 2]).map(() => withTts(liveUrls, async (url) => {
        const generated = await gpuJsonAt<{
          audio_wav_b64: string;
          conversion_meta: Record<string, unknown>;
        }>(url, "/v1/tts/clone", {
          text: ttsForGpu,
          prompt_audio: promptB64,
          duration_factor: syncToJp ? 1 : durationFactor,
          lang: "ZH",
          skip_seed_vc: true,
          align_start_s: alignStartS,
        });
        const raw = matchPeak10Loudness(Buffer.from(generated.audio_wav_b64, "base64"), prompt);
        const timing = wavAlignmentTiming(raw);
        return { generated, audio: raw, timing, url, health: healthByUrl.get(url)! };
      })),
    );
    const results = settled.flatMap((row) => (row.status === "fulfilled" ? [row.value] : []));
    if (!results.length) {
      const first = settled.find((row) => row.status === "rejected") as PromiseRejectedResult | undefined;
      throw first?.reason instanceof Error ? first.reason : new Error("三条 TTS 全部失败");
    }

    const referenceTiming = autoRunId != null && syncToJp && preservePromptAudio ? wavTiming(prompt) : null;
    const processed = await Promise.all(results.map(async (row, index) => {
      const reference = gapReference ?? manualGapReference;
      const referenceParts=reference?speechChunks(reference,TWO_PART_JP_GAP_S).chunks.length:0;
      const canRegroup=[2,3].includes(referenceParts);
      let regrouped: {audio:Buffer;meta:RegroupMeta}|null=null;
      // 自动线路传原始分行稿；normalizeScript会将换行转为可朗读标点，不能用它恢复语义分界。
      const scriptPolicy:BodyScriptPolicy=autoRunId!=null && ["lines","relaxed"].includes(String(body.bodyScriptPolicy)) ? body.bodyScriptPolicy as BodyScriptPolicy : "strict";
      const groupingScript=scriptPolicy==="lines"&&typeof body.ttsText==="string"?body.ttsText:script.spokenText;
      // 新增“片数恰好也核对切口”只用于自动工作流；真人Zero-shot原本可纯波形对齐的路径不新增ASR/模型调用。
      if(canRegroup && (autoRunId != null || speechChunks(row.audio).chunks.length>referenceParts))try{regrouped=await (autoRunId != null ? withLlmMetrics(autoRunId,stem,()=>withChatModel(body.autoRunModel ?? "primary",()=>regroupTwoPartAudio(row.audio,groupingScript,stem,referenceParts,scriptPolicy))) : regroupTwoPartAudio(row.audio,groupingScript,stem,referenceParts,scriptPolicy));}catch(error){
        // 单条识别/API失败不能让其他候选及已生成的原音频一起丢失，交给原稿重TTS预算。
        regrouped={audio:row.audio,meta:{version:referenceParts===3?"three-parts-regroup-v1":"two-parts-regroup-v1",requiredParts:referenceParts,consistent:false,reason:String(error),segments:[]}};
      }
      const inputAudio = regrouped?.audio ?? row.audio;
      const regroupFailed = regrouped?.meta.consistent === false;
      // 优先修间距再评判，避免“文字—空白—文字”因少停顿被误判成正文少字。
      // 命中时跳过旧的候选拉伸/补槽，之后沿用裁首尾、校字、比和择优，不放宽任何门槛。
      const gapAligned = regroupFailed ? {audio:row.audio,meta:{version:referenceParts===3?"three-parts-v1":"two-parts-v1",requiredParts:referenceParts,status:"error" as const,pass:false,lo:.85,hi:1.15,toleranceSeconds:.3,parts:[],reason:"逐段ASR核对或合并方案失败，须原稿重新TTS"}}
        : gapReference ? alignParts(inputAudio, gapReference)
        : manualGapReference ? alignZeroShotParts(inputAudio, manualGapReference) : null;
      const got = target?.key === "speech" ? row.timing.speech : row.timing.duration;
      const stretch = gapAligned ? 1 : !feedbackRound && target ? pickSpeechStretch(got, target.value, DUR_OK_S, durationFactor) : 1;
      const laidOut = gapAligned ? gapAligned.audio : syncToJp && !feedbackRound
        ? Buffer.from(layoutSpeechWav(
            row.audio,
            { start: row.timing.start, end: row.timing.end },
            stretch,
            { start: jpTiming.start, dur: jpTiming.dur },
          ))
        : row.audio;
      // 仅自动场景工作流：先完成既有拉伸/对时，再裁多余首尾静音，之后保存、ASR 和拼接
      // 都使用同一份裁后音频。普通手动合成及非演出工作流保持既有流程。
      const edgeTrim = feedbackRound || (autoRunId != null && syncToJp && preservePromptAudio)
        ? limitWavEdgeSilence(laidOut, prompt) : null;
      // 裁首静音会移动正文位置；检测门槛区域必须跟随保存后的音频，不能留在裁前坐标。
      if (gapAligned?.meta.splitRegions && edgeTrim) gapAligned.meta.splitRegions=gapAligned.meta.splitRegions.map(r=>({...r,startSeconds:r.startSeconds-edgeTrim.meta.trimmedLeading,endSeconds:r.endSeconds-edgeTrim.meta.trimmedLeading}));
      const audio = edgeTrim?.audio ?? laidOut;
      const timing = wavTiming(audio);
      const measured = target?.key === "speech" ? timing.speech : timing.duration;
      const score = target ? Math.abs(measured - target.value) : 0;
      const pass = gapAligned ? gapAligned.meta.pass : !target || score <= DUR_OK_S;
      return {
        index,
        stretch,
        audio,
        timing,
        score,
        pass,
        edgeTrim: edgeTrim?.meta ?? null,
        gapAlignment: gapAligned?.meta ?? null,
        regroup: regrouped?.meta ?? null,
        scriptPolicy, groupingScript,
        beforeRegroup: regrouped ? row.audio : null,
        rawSpeech: row.timing.speech,
        rawDur: row.timing.duration,
        meta: row.generated.conversion_meta,
        url: row.url,
        health: row.health,
      };
    }));
    const passed = processed.filter((row) => row.pass);
    // 人工模板分支三条都要保留，时长检测仅记录，不能筛到最后只剩一条。
    // 仅限已验证归属的自动工作流，普通合成保持原有筛选规则。
    const manualTemplates = autoRunId != null && body.manualTemplates === true;
    const keep = gapReference && processed.some(row => row.gapAlignment) || manualTemplates ? processed : passed.length ? passed : [processed.reduce((a,b)=>a.score<=b.score?a:b)];

    const ids: string[] = [];
    for (const row of keep) {
      const record = (
        await sql<{ id: string }[]>`
          INSERT INTO line_tts_versions (
            stem, auto_run_id, speaker, voice_version_id, voice_gpu_key,
            tts_text, spoken_text, subtitle_text,
            jp_text_snapshot, game_zh_text_snapshot,
            duration_factor, emo_alpha,
            engine_model_version, engine_model_revision, engine_source_revision,
            engine_package_version, engine_precision, engine_device, engine_url
          ) VALUES (
            ${stem}, ${autoRunId}, ${line.speaker}, NULL, ${`zeroshot-${promptLang}`},
            ${script.ttsText}, ${script.spokenText}, ${subtitleText},
            ${line.text_jp}, ${line.text_zh},
            ${syncToJp ? row.stretch : durationFactor}, ${0},
            ${row.health.model_version ?? null}, ${row.health.model_revision ?? null},
            ${row.health.source_revision ?? null}, ${row.health.package_version ?? null},
            ${row.health.precision ?? null}, ${row.health.device ?? null}, ${row.url}
          )
          RETURNING id
        `
      )[0];
      const relativePath = path.posix.join("tts", stem, `${record.id}.wav`);
      const manifestPath = path.posix.join("tts", stem, `${record.id}.json`);
      const conversion = {
        tts_text_sent: ttsForGpu,
        ...(manualTemplates ? { manual_template: true, quality_review: "manual-required" } : {}),
        auto_run_final_subtitle: finalSubtitleText,
        ...(autoRunId != null ? { body_script_policy:row.scriptPolicy, body_grouping_script:row.groupingScript } : {}),
        ...row.meta,
        pipeline: "jp-zeroshot",
        timing_strategy: row.gapAlignment ? (row.gapAlignment.requiredParts===3?"three_parts_timeline":"two_parts_timeline") : feedbackRound ? "fallback_raw_feedback" : syncToJp ? "scene_timeline" : "field_natural_rate",
        stem,
        prompt_stem: promptStem,
        prompt_lang: promptLang,
        prompt_note: promptNote,
        prompt_path: typeof body.promptPath === "string" ? body.promptPath : `${promptLang}/${promptStem}.mp3`,
        preserve_prompt_audio: preservePromptAudio,
        layout_slot: layoutSlot,
        seed_vc: "skipped",
        ui_duration_factor: durationFactor,
        gpu_duration_factor: syncToJp ? 1 : durationFactor,
        stretch_lo: Math.max(0.5, Math.round((durationFactor - 0.2) * 50) / 50),
        stretch_hi: Math.min(2, Math.round((durationFactor + 0.2) * 50) / 50),
        post_stretch: row.stretch,
        auto_run_edge_trim: row.edgeTrim,
        auto_run_gap_alignment: row.gapAlignment,
        two_parts_regroup: row.regroup ? {...row.regroup,source_path:path.posix.join("tts",stem,`${record.id}-before-regroup.wav`)} : null,
        auto_run_reference: referenceTiming ? { start: referenceTiming.start, end: referenceTiming.end,
          dur: referenceTiming.duration, speech: referenceTiming.speech } : null,
        raw_speech_s: row.rawSpeech,
        raw_dur_s: row.rawDur,
        speech_pass: row.pass,
        speech_score: row.score,
      };
      const absolutePath = path.join(process.cwd(), "data", relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await Promise.all([
        writeFile(absolutePath, row.audio),
        writeFile(path.join(process.cwd(), "data", manifestPath), JSON.stringify(conversion, null, 2)),
      ]);
      if(row.beforeRegroup)await writeFile(path.join(process.cwd(),"data","tts",stem,`${record.id}-before-regroup.wav`),row.beforeRegroup);
      await sql`
        UPDATE line_tts_versions SET
          status = 'ready', audio_path = ${relativePath}, audio_bytes = ${row.audio.length},
          raw_audio_path = NULL, manifest_path = ${manifestPath},
          conversion_meta = ${sql.json(JSON.parse(JSON.stringify(conversion)))},
          duration_factor = ${syncToJp ? row.stretch : durationFactor},
          start_s = ${row.timing.start}, end_s = ${row.timing.end},
          dur_s = ${row.timing.duration}, speech_s = ${row.timing.speech},
          completed_at = now(), error = NULL
        WHERE id = ${record.id}
      `;
      if(autoRunId != null && row.regroup)await sql`INSERT INTO line_auto_run_events(run_id,step,level,message,payload) VALUES(${autoRunId},'two-parts-regroup','result',${row.regroup.consistent ? `逐段Qwen核字一致，按模型建议连续合并为${row.regroup.requiredParts??2}段` : "逐段Qwen核字或分组失败，需原稿重新TTS"},${sql.json(JSON.parse(JSON.stringify({ttsId:String(record.id),...row.regroup})))})`;
      if (autoRunId != null && row.gapAlignment) {
        await sql`INSERT INTO line_auto_run_events(run_id,step,level,message,payload)
          VALUES(${autoRunId},'gap-align','result',
            ${`#${record.id} 先逐段85%～115%缩放并调整间距，再检查逐段余差`},
            ${sql.json({ ttsId: String(record.id), referencePath: typeof body.promptPath === "string" ? body.promptPath : `${promptLang}/${promptStem}.mp3`, ...row.gapAlignment })})`;
      }
      ids.push(record.id);
    }
    return NextResponse.json({ ok: true, id: ids[0], ids });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
