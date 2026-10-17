import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { twoLineSubtitle } from "@/lib/auto-run-subtitle";
import { sql } from "@/lib/db";
import { applyPronunciations, type Pronunciation } from "@/lib/pronounce";
import {
  parseLineLang,
  parseSeedVcRef,
  parseTtsDefaults,
  seedOriginalLang,
  seedVcGpuMode,
  type EmoRef,
  type SeedVcRef,
} from "@/lib/tts-defaults";
import { gpuJson, normalizeScript, TTS_URL, wavTiming } from "@/lib/tts-gpu";
import { loadNearbySpeakerRefs } from "@/lib/prompt-refs";

export const dynamic = "force-dynamic";
export const maxDuration = 1200;

type LineInfo = {
  stem: string;
  speaker: string | null;
  speaker_name: string | null;
  text_jp: string | null;
  text_zh: string | null;
  jp_start_s: number | null;
  jp_dur_s: number | null;
  dialogue_mode: string | null;
  kind: string | null;
  subtitle_italic: boolean | null;
};

type VoiceVersion = {
  id: number;
  source_lang: "jp" | "cn" | "en";
  gpu_speaker_key: string;
  embedding_path: string;
  reference_wav_path: string;
  source_wav_path: string | null;
  created_at: string;
  engine_precision: string | null;
  engine_device: string | null;
};

type EngineHealth = {
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

async function getLine(stem: string) {
  return (
    await sql<LineInfo[]>`
      SELECT l.stem, l.speaker, COALESCE(s.name_zh, l.speaker) AS speaker_name,
             l.text_jp, l.text_zh, l.kind, l.subtitle_italic, m.jp_start_s, m.jp_dur_s, m.dialogue_mode
      FROM lines l
      LEFT JOIN speakers s ON s.code = l.speaker
      LEFT JOIN line_meta m ON m.stem = l.stem
      WHERE l.stem = ${stem}
    `
  )[0];
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ stem: string }> },
) {
  const { stem } = await ctx.params;
  if (!stemOk(stem)) return NextResponse.json({ error: "bad stem" }, { status: 400 });
  const line = await getLine(stem);
  if (!line) return NextResponse.json({ error: "台词不存在" }, { status: 404 });

  const versions = line.speaker
    ? await sql<VoiceVersion[]>`
        SELECT v.id, v.source_lang, v.gpu_speaker_key, v.embedding_path, v.reference_wav_path, v.source_wav_path,
               v.created_at, v.engine_precision, v.engine_device
        FROM voice_bank_versions v
        JOIN voice_banks b ON b.id = v.bank_id
        WHERE b.speaker = ${line.speaker} AND v.status = 'ready'
          AND v.gpu_speaker_key IS NOT NULL
          AND v.embedding_path IS NOT NULL
          AND v.reference_wav_path IS NOT NULL
        ORDER BY v.id DESC
      `
    : [];

  const history = await sql`
    SELECT id, parent_tts_id::text AS parent_tts_id, auto_run_id::text AS auto_run_id, voice_version_id, voice_gpu_key, tts_text, spoken_text,
           subtitle_text, duration_factor, emo_alpha, audio_path,
           audio_bytes, start_s, end_s, dur_s, speech_s,
           is_used, used_at, heard_at, play_count, status, error,
           engine_precision, engine_device, conversion_meta, raw_audio_path, llm_tokens, llm_speed, created_at, completed_at
    FROM line_tts_versions
    WHERE stem = ${stem}
    ORDER BY id DESC
  `;

  const [speakerRow] = line.speaker
    ? await sql<{ tts_defaults: unknown }[]>`
        SELECT tts_defaults FROM speakers WHERE code = ${line.speaker}
      `
    : [];

  const timbreRefs = line.speaker
    ? await sql<{ id: number; stem: string; jp_dur_s: number | null; text_jp: string | null; text_zh: string | null; note: string }[]>`
        SELECT l.id, t.stem, m.jp_dur_s, l.text_jp, l.text_zh, t.note
        FROM speaker_timbre_refs t
        JOIN lines l ON l.stem = t.stem
        LEFT JOIN line_meta m ON m.stem = t.stem
        WHERE t.speaker = ${line.speaker}
        ORDER BY t.ordinal, t.stem
      `
    : [];
  const presetStems = new Set(timbreRefs.map((row) => row.stem));
  const nearbyRefs = line.speaker
    ? (await loadNearbySpeakerRefs(line.speaker, stem)).filter((row) => !presetStems.has(row.stem))
    : [];
  let hasEn = false;
  let hasJp = false;
  try {
    await access(path.join(process.cwd(), "data", "en", `${stem}.mp3`));
    hasEn = true;
  } catch {
    hasEn = false;
  }
  try {
    await access(path.join(process.cwd(), "data", "jp", `${stem}.mp3`));
    hasJp = true;
  } catch {
    hasJp = false;
  }

  return NextResponse.json({
    line,
    versions,
    history,
    pauseSyntax: "[停顿=500]",
    defaults: parseTtsDefaults(speakerRow?.tts_defaults),
    timbreRefs,
    nearbyRefs,
    hasEn,
    hasJp,
  });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ stem: string }> },
) {
  const { stem } = await ctx.params;
  if (!stemOk(stem)) return NextResponse.json({ error: "bad stem" }, { status: 400 });
  const line = await getLine(stem);
  if (!line) return NextResponse.json({ error: "台词不存在" }, { status: 404 });
  if (!line.speaker) return NextResponse.json({ error: "台词没有说话人" }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as {
    voiceVersionId?: number;
    ttsText?: string;
    subtitleText?: string;
    durationFactor?: number;
    emoAlpha?: number;
    emoRef?: EmoRef;
    seedVcRef?: SeedVcRef;
    timbreStem?: string;
  };

  let script: { ttsText: string; spokenText: string };
  try {
    script = normalizeScript(body.ttsText, line.text_zh ?? undefined);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
  const voiceVersionId = Number(body.voiceVersionId);
  const durationFactor = Number(body.durationFactor ?? 1);
  const emoAlpha = Number(body.emoAlpha ?? 0.4);
  if (!Number.isInteger(voiceVersionId) || voiceVersionId <= 0) {
    return NextResponse.json({ error: "请选择音色版本" }, { status: 400 });
  }
  if (!Number.isFinite(durationFactor) || durationFactor < 0.5 || durationFactor > 2) {
    return NextResponse.json({ error: "时长倍率必须在 0.5 到 2.0 之间" }, { status: 400 });
  }
  if (!Number.isFinite(emoAlpha) || emoAlpha < 0 || emoAlpha > 1) {
    return NextResponse.json({ error: "情绪参考强度必须在 0 到 1 之间" }, { status: 400 });
  }
  const subtitleText = typeof body.subtitleText === "string" && body.subtitleText.trim()
    ? twoLineSubtitle(body.subtitleText)
    : null;
  const emoRef: EmoRef = parseLineLang(body.emoRef) ?? "en";
  const timbreStem = typeof body.timbreStem === "string" ? body.timbreStem : "";
  if (timbreStem) {
    const owned = await sql<{ stem: string }[]>`
      SELECT stem FROM speaker_timbre_refs
      WHERE speaker = ${line.speaker} AND stem = ${timbreStem}
    `;
    if (!owned[0]) return NextResponse.json({ error: "请下拉选择一条日文参考音色" }, { status: 400 });
  }
  const seedVcRef: SeedVcRef = timbreStem ? "jp" : parseSeedVcRef(body.seedVcRef);
  const seedLang = timbreStem ? "jp" : seedOriginalLang(seedVcRef, emoRef);
  const gpuMode = timbreStem ? "original" : seedVcGpuMode(seedVcRef);

  const voice = (
    await sql<VoiceVersion[]>`
      SELECT v.id, v.source_lang, v.gpu_speaker_key, v.embedding_path, v.reference_wav_path, v.source_wav_path,
             v.created_at, v.engine_precision, v.engine_device
      FROM voice_bank_versions v
      JOIN voice_banks b ON b.id = v.bank_id
      WHERE v.id = ${voiceVersionId} AND b.speaker = ${line.speaker}
        AND v.status = 'ready' AND v.gpu_speaker_key IS NOT NULL
        AND v.embedding_path IS NOT NULL AND v.reference_wav_path IS NOT NULL
    `
  )[0];
  if (!voice) return NextResponse.json({ error: "音色版本不存在或不可用" }, { status: 400 });

  const missingLang = (lang: string) =>
    `该句没有${lang === "en" ? "英" : lang === "cn" ? "中" : "日"}文配音`;
  let health: EngineHealth;
  let embedding: Buffer;
  let reference: Buffer;
  let emoAudio: Buffer;
  let originalAudio: Buffer;
  let repairReference: Buffer;
  try {
    [health, embedding, reference, emoAudio, originalAudio, repairReference] = await Promise.all([
      gpuJson<EngineHealth>("/health", undefined, 30_000),
      readFile(path.join(process.cwd(), "data", voice.embedding_path)),
      readFile(path.join(process.cwd(), "data", voice.reference_wav_path)),
      readFile(path.join(process.cwd(), "data", emoRef, `${stem}.mp3`)).catch(() => {
        throw new Error(missingLang(emoRef));
      }),
      readFile(
        path.join(process.cwd(), "data", timbreStem ? "jp" : seedLang, `${timbreStem || stem}.mp3`),
      ).catch(() => {
        throw new Error(timbreStem ? "选中的日文参考音色没有音频" : missingLang(seedLang));
      }),
      readFile(path.join(process.cwd(), "data", voice.source_wav_path || voice.reference_wav_path)),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = message.includes("没有");
    return NextResponse.json(
      { error: missing ? message : `准备 TTS 失败：${message}` },
      { status: missing ? 400 : 503 },
    );
  }

  const record = (
    await sql<{ id: string }[]>`
      INSERT INTO line_tts_versions (
        stem, speaker, voice_version_id, voice_gpu_key,
        tts_text, spoken_text, subtitle_text,
        jp_text_snapshot, game_zh_text_snapshot,
        duration_factor, emo_alpha,
        engine_model_version, engine_model_revision, engine_source_revision,
        engine_package_version, engine_precision, engine_device, engine_url
      ) VALUES (
        ${stem}, ${line.speaker}, ${voice.id}, ${voice.gpu_speaker_key},
        ${script.ttsText}, ${script.spokenText}, ${subtitleText},
        ${line.text_jp}, ${line.text_zh},
        ${durationFactor}, ${emoAlpha},
        ${health.model_version ?? null}, ${health.model_revision ?? null},
        ${health.source_revision ?? null}, ${health.package_version ?? null},
        ${health.precision ?? null}, ${health.device ?? null}, ${TTS_URL}
      )
      RETURNING id
    `
  )[0];

  await sql`UPDATE line_tts_versions SET
    audio_path = ${path.posix.join("tts", stem, `${record.id}.wav`)},
    raw_audio_path = ${path.posix.join("tts", stem, `${record.id}-raw.wav`)},
    manifest_path = ${path.posix.join("tts", stem, `${record.id}.json`)}
    WHERE id = ${record.id}`;
  try {
    await gpuJson("/v1/speaker/register", {
      speaker: voice.gpu_speaker_key,
      embedding_pt_b64: embedding.toString("base64"),
      reference_wav_b64: reference.toString("base64"),
    });
    const lexicon = await sql<Pronunciation[]>`
      SELECT id, src, dst, note FROM pronunciations
    `;
    const ttsForGpu = applyPronunciations(script.ttsText, lexicon);
    const generated = await gpuJson<{ audio_wav_b64: string; raw_audio_wav_b64: string; conversion_meta: Record<string, unknown> }>("/v1/tts", {
      text: ttsForGpu,
      speaker: voice.gpu_speaker_key,
      emo_audio: emoAudio.toString("base64"),
      seed_original_audio: originalAudio.toString("base64"),
      seed_vc_ref: gpuMode,
      original_lang: seedLang,
      repair_reference_audio: repairReference.toString("base64"),
      repair_reference_lang: voice.source_lang,
      duration_factor: durationFactor,
      lang: "ZH",
      emo_alpha: emoAlpha,
      align_start_s: line.dialogue_mode === "field" ? null : line.jp_start_s,
      align_dur_s: line.dialogue_mode === "field" ? null : line.jp_dur_s,
    });
    if (!generated.conversion_meta || !generated.raw_audio_wav_b64) throw new Error("TTS 服务未完成必需的 Seed-VC 音色修复，请检查节点版本");
    const audio = Buffer.from(generated.audio_wav_b64, "base64");
    const rawAudio = Buffer.from(generated.raw_audio_wav_b64, "base64");
    const rawPath = path.posix.join("tts", stem, `${record.id}-raw.wav`);
    const manifestPath = path.posix.join("tts", stem, `${record.id}.json`);
    const conversion = {
      tts_text_sent: ttsForGpu,
      ...generated.conversion_meta, pipeline: "indextts-seed-vc", stem,
      timing_strategy: line.dialogue_mode === "field" ? "field_natural_rate" : "scene_timeline",
      voice_version_id: voice.id, raw_audio_path: rawPath,
      seed_vc_ref: seedVcRef,
      emo_ref: emoRef,
      original_lang: seedLang,
      timbre_stem: timbreStem || null,
      reference_audio_path: generated.conversion_meta.reference_kind === "embedding_source"
        ? voice.source_wav_path || voice.reference_wav_path
        : `${seedLang}/${stem}.mp3`,
    };
    const relativePath = path.posix.join("tts", stem, `${record.id}.wav`);
    const absolutePath = path.join(process.cwd(), "data", relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const timing = wavTiming(audio);
    const rawTiming = wavTiming(rawAudio);
    const manifest = { id: record.id, stem, speaker: line.speaker, tts_text: script.ttsText,
      voice_version_id: voice.id, source_lang: voice.source_lang, tts_engine: health,
      duration_factor: durationFactor, emo_alpha: emoAlpha, conversion,
      timing, raw_timing: rawTiming, audio_path: relativePath, raw_audio_path: rawPath };
    await Promise.all([
      writeFile(absolutePath, audio),
      writeFile(path.join(process.cwd(), "data", rawPath), rawAudio),
      writeFile(path.join(process.cwd(), "data", manifestPath), JSON.stringify(manifest, null, 2)),
    ]);
    await sql`
      UPDATE line_tts_versions SET
        status = 'ready', audio_path = ${relativePath}, audio_bytes = ${audio.length},
        raw_audio_path = ${rawPath}, manifest_path = ${manifestPath}, conversion_meta = ${sql.json(conversion)},
        start_s = ${timing.start}, end_s = ${timing.end},
        dur_s = ${timing.duration}, speech_s = ${timing.speech},
        completed_at = now(), error = NULL
      WHERE id = ${record.id}
    `;
    return NextResponse.json({ ok: true, id: record.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      UPDATE line_tts_versions
      SET status = 'failed', error = ${message}, completed_at = now()
      WHERE id = ${record.id}
    `;
    return NextResponse.json({ error: message, id: record.id }, { status: 500 });
  }
}
