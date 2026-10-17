import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 1200;

const TTS_URL = process.env.TTS_URL ?? "";

function speakerOk(code: string) {
  return /^[\w.\-]+$/.test(code);
}

type SelectedClip = {
  stem: string;
  text_zh: string | null;
  text_jp: string | null;
  jp_dur_s: number | null;
  cn_dur_s: number | null;
  en_dur_s: number | null;
};

type EmbedResult = {
  success: boolean;
  speaker: string;
  n_clips: number;
  batch_count: number;
  medoid_index: number;
  similarities: number[];
  manifest: {
    source_clips: { id: string; ordinal: number; duration_s: number }[];
    batches: {
      batch_no: number;
      duration_s: number;
      source_ids: string[];
      similarity: number;
    }[];
    [key: string]: unknown;
  };
  embedding_pt_b64: string;
  reference_wav_b64: string;
  source_wav_b64: string;
  message?: string;
};

type EngineHealth = {
  model_version?: string;
  model_revision?: string;
  source_revision?: string;
  package_version?: string;
  precision?: string;
  device?: string;
};

async function gpuHealth(): Promise<EngineHealth> {
  const response = await fetch(`${TTS_URL}/health`, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await response.json().catch(() => ({}))) as EngineHealth & { detail?: string };
  if (!response.ok) throw new Error(data.detail || `GPU health HTTP ${response.status}`);
  return data;
}

async function gpuPost<T>(endpoint: string, body: unknown): Promise<T> {
  const response = await fetch(`${TTS_URL}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1_200_000),
  });
  const data = (await response.json().catch(() => ({}))) as T & { detail?: string; message?: string };
  if (!response.ok) {
    throw new Error(data.detail || data.message || `GPU HTTP ${response.status}`);
  }
  return data;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ speaker: string }> },
) {
  const { speaker } = await ctx.params;
  if (!speakerOk(speaker)) return NextResponse.json({ error: "bad speaker" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { slot?: number; sourceLang?: string };
  const slot = Math.max(1, body.slot ?? 1);
  const sourceLang = body.sourceLang ?? "cn";
  if (sourceLang !== "jp" && sourceLang !== "cn" && sourceLang !== "en") {
    return NextResponse.json({ error: "embedding 音源必须是日文、中文或英文" }, { status: 400 });
  }

  const bank = (
    await sql<{ id: number }[]>`
      SELECT id FROM voice_banks
      WHERE speaker = ${speaker} AND kind = '基准' AND slot = ${slot}
    `
  )[0];
  if (!bank) return NextResponse.json({ error: "请先查找并选择音源" }, { status: 400 });

  const clips = await sql<SelectedClip[]>`
    SELECT l.stem, l.text_zh, l.text_jp, m.jp_dur_s, m.cn_dur_s, m.en_dur_s
    FROM voice_bank_draft_clips d
    JOIN lines l ON l.stem = d.stem
    LEFT JOIN line_meta m ON m.stem = d.stem
    WHERE d.bank_id = ${bank.id} AND d.selected
    ORDER BY d.recommended DESC,
             CASE ${sourceLang}
               WHEN 'jp' THEN COALESCE(m.jp_dur_s, m.jp_speech_s, 0)
               WHEN 'en' THEN COALESCE(m.en_dur_s, m.en_speech_s, 0)
               ELSE COALESCE(m.cn_dur_s, m.cn_speech_s, 0)
             END DESC,
             l.stem
  `;
  if (!clips.length) return NextResponse.json({ error: "至少选择一条音源" }, { status: 400 });

  const clipDur = (clip: SelectedClip) =>
    sourceLang === "jp" ? clip.jp_dur_s ?? 0 : sourceLang === "en" ? clip.en_dur_s ?? 0 : clip.cn_dur_s ?? 0;
  const selectedDuration = clips.reduce((sum, clip) => sum + clipDur(clip), 0);
  if (selectedDuration > 15) return NextResponse.json({ error: "已选原音频总时长不能超过 15 秒，请减少素材" }, { status: 400 });

  let engine: EngineHealth;
  try {
    engine = await gpuHealth();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `TTS 服务不可用：${message}` }, { status: 503 });
  }

  const sourceDuration = clipDur;
  const example = clips.reduce((best, clip) =>
    sourceDuration(clip) > sourceDuration(best) ? clip : best,
  );
  if (!example.text_zh) {
    return NextResponse.json({ error: `示例 ${example.stem} 没有中文字幕` }, { status: 400 });
  }

  const version = (
    await sql<{ id: number }[]>`
      INSERT INTO voice_bank_versions (
        bank_id, status, source_lang, n_clips, total_dur_s, example_stem, example_emo_alpha,
        engine_model_version, engine_model_revision, engine_source_revision,
        engine_package_version, engine_precision, engine_device, engine_url
      ) VALUES (
        ${bank.id}, 'building', ${sourceLang}, ${clips.length},
        ${clips.reduce((sum, clip) => sum + sourceDuration(clip), 0)},
        ${example.stem}, 0.5,
        ${engine.model_version ?? null}, ${engine.model_revision ?? null},
        ${engine.source_revision ?? null}, ${engine.package_version ?? null},
        ${engine.precision ?? null}, ${engine.device ?? null}, ${TTS_URL}
      )
      RETURNING id
    `
  )[0];

  const gpuKey = `${speaker}-v${version.id}`;
  const relativeDir = path.posix.join("embedded", speaker, `v${version.id}`);
  const absoluteDir = path.join(process.cwd(), "data", relativeDir);

  try {
    const sourceFiles = clips.map((clip) =>
      path.join(process.cwd(), "data", sourceLang, `${clip.stem}.mp3`),
    );
    const encodedAudios = await Promise.all(
      sourceFiles.map(async (file) => (await readFile(file)).toString("base64")),
    );

    const embedded = await gpuPost<EmbedResult>("/v1/speaker/embed", {
      speaker: gpuKey,
      audios: encodedAudios,
      audio_ids: clips.map((clip) => clip.stem),
      target_seconds: 15,
      gap_seconds: 0.12,
      trim_silence: true,
      prebatched: false,
    });

    const jpSource = path.join(process.cwd(), "data", "jp", `${example.stem}.mp3`);
    const jpBytes = await readFile(jpSource);
    const originalLang = sourceLang === "en" ? "en" : "jp";
    const originalBytes = originalLang === "en"
      ? await readFile(path.join(process.cwd(), "data", "en", `${example.stem}.mp3`))
      : jpBytes;
    const generated = await gpuPost<{ audio_wav_b64: string; raw_audio_wav_b64: string; conversion_meta: Record<string, unknown> }>("/v1/tts", {
      text: example.text_zh,
      speaker: gpuKey,
      emo_audio: jpBytes.toString("base64"),
      seed_original_audio: originalBytes.toString("base64"),
      seed_vc_ref: "auto",
      original_lang: originalLang,
      repair_reference_audio: embedded.source_wav_b64,
      repair_reference_lang: sourceLang,
      duration_factor: 1,
      lang: "ZH",
      emo_alpha: 0.5,
    });

    await mkdir(absoluteDir, { recursive: true });
    const embeddingPath = path.posix.join(relativeDir, "speaker.pt");
    const sourcePath = path.posix.join(relativeDir, "source.wav");
    const referencePath = path.posix.join(relativeDir, "reference.wav");
    const manifestPath = path.posix.join(relativeDir, "manifest.json");
    const exampleZhPath = path.posix.join(relativeDir, "example-zh.wav");
    const exampleJaPath = path.posix.join(relativeDir, "example-ja.mp3");
    const manifest = {
      ...embedded.manifest,
      version_id: version.id,
      bank_id: bank.id,
      speaker,
      source_lang: sourceLang,
      source_wav_path: sourcePath,
      gpu_speaker_key: gpuKey,
      engine: { ...engine, url: TTS_URL },
      example: {
        stem: example.stem,
        text_zh: example.text_zh,
        text_jp: example.text_jp,
        emo_alpha: 0.5,
        conversion_meta: generated.conversion_meta,
      },
    };
    await Promise.all([
      writeFile(path.join(process.cwd(), "data", sourcePath), Buffer.from(embedded.source_wav_b64, "base64")),
      writeFile(path.join(absoluteDir, "example-raw.wav"), Buffer.from(generated.raw_audio_wav_b64, "base64")),
      writeFile(path.join(process.cwd(), "data", embeddingPath), Buffer.from(embedded.embedding_pt_b64, "base64")),
      writeFile(path.join(process.cwd(), "data", referencePath), Buffer.from(embedded.reference_wav_b64, "base64")),
      writeFile(path.join(process.cwd(), "data", manifestPath), `${JSON.stringify(manifest, null, 2)}\n`),
      writeFile(path.join(process.cwd(), "data", exampleZhPath), Buffer.from(generated.audio_wav_b64, "base64")),
      writeFile(path.join(process.cwd(), "data", exampleJaPath), jpBytes),
    ]);

    const similarities = embedded.similarities;
    const batchByStem = new Map<string, number>();
    for (const batch of embedded.manifest.batches) {
      for (const stem of batch.source_ids) batchByStem.set(stem, batch.batch_no);
    }
    const totalSpeech = embedded.manifest.source_clips.reduce(
      (sum, clip) => sum + clip.duration_s,
      0,
    );
    await sql.begin(async (tx) => {
      await tx`
        UPDATE voice_bank_versions SET
          status = 'ready', gpu_speaker_key = ${gpuKey},
          n_clips = ${clips.length}, total_dur_s = ${totalSpeech},
          embedding_path = ${embeddingPath}, reference_wav_path = ${referencePath},
          source_wav_path = ${sourcePath},
          result_dir = ${relativeDir}, manifest_path = ${manifestPath},
          batch_count = ${embedded.batch_count},
          similarity_min = ${Math.min(...similarities)},
          similarity_mean = ${similarities.reduce((a, b) => a + b, 0) / similarities.length},
          similarity_max = ${Math.max(...similarities)},
          example_stem = ${example.stem}, example_emo_alpha = 0.5,
          example_zh_path = ${exampleZhPath}, example_ja_path = ${exampleJaPath},
          completed_at = now(), error = NULL
        WHERE id = ${version.id}
      `;
      await tx`DELETE FROM voice_bank_version_clips WHERE version_id = ${version.id}`;
      for (let index = 0; index < clips.length; index += 1) {
        const clip = clips[index];
        await tx`
          INSERT INTO voice_bank_version_clips (version_id, stem, ordinal, batch_no)
          VALUES (${version.id}, ${clip.stem}, ${index + 1}, ${batchByStem.get(clip.stem) ?? null})
        `;
      }
    });

    return NextResponse.json({ ok: true, versionId: version.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      UPDATE voice_bank_versions
      SET status = 'failed', error = ${message}, completed_at = now()
      WHERE id = ${version.id}
    `;
    return NextResponse.json({ error: message, versionId: version.id }, { status: 500 });
  }
}
