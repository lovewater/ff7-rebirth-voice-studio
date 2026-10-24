import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { applyPronunciations, type Pronunciation } from "@/lib/pronounce";
import { gpuJson, wavTiming } from "@/lib/tts-gpu";

export const dynamic = "force-dynamic";
export const maxDuration = 1200;

const TTS_URL = process.env.TTS_URL ?? "";

function speakerOk(code: string) {
  return /^[\w.\-]+$/.test(code);
}

type EmbedResult = {
  embedding_pt_b64: string;
  reference_wav_b64: string;
  source_wav_b64: string;
};

function draftRoot(speaker: string, draftId: string) {
  return path.join(process.cwd(), "data", "embedded", speaker, "_drafts", draftId);
}

function parseTexts(raw: unknown) {
  const text = typeof raw === "string" ? raw : "";
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error("至少写一行中文试读文本");
  if (lines.length > 20) throw new Error("一次最多 20 行");
  if (lines.some((line) => line.length > 80)) throw new Error("每行中文不超过 80 字");
  return lines;
}

async function pruneOldDrafts(speaker: string) {
  const root = path.join(process.cwd(), "data", "embedded", speaker, "_drafts");
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  await Promise.all(
    names.map(async (name) => {
      const dir = path.join(root, name);
      try {
        const info = await stat(dir);
        if (info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }),
  );
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ speaker: string }> },
) {
  const { speaker } = await ctx.params;
  if (!speakerOk(speaker)) return NextResponse.json({ error: "bad speaker" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { stems?: string[]; texts?: string };
  const stems = Array.isArray(body.stems) ? body.stems.filter((stem) => /^[\w.\-]+$/.test(stem)) : [];
  if (!stems.length) return NextResponse.json({ error: "先勾选英文音源" }, { status: 400 });
  let texts: string[];
  try {
    texts = parseTexts(body.texts);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }

  const clips = await sql<{ stem: string; en_dur_s: number | null }[]>`
    SELECT l.stem, m.en_dur_s
    FROM lines l
    LEFT JOIN line_meta m ON m.stem = l.stem
    WHERE l.speaker = ${speaker} AND l.stem = ANY(${stems})
  `;
  if (clips.length !== stems.length) {
    return NextResponse.json({ error: "英文音源不属于这个人物" }, { status: 400 });
  }
  const totalDur = clips.reduce((sum, clip) => sum + (clip.en_dur_s ?? 0), 0);
  if (totalDur > 15) {
    return NextResponse.json({ error: "英文音源总长不能超过 15 秒" }, { status: 400 });
  }

  let encodedAudios: string[];
  let emoAudio: string;
  try {
    const files = await Promise.all(
      stems.map((stem) => readFile(path.join(process.cwd(), "data", "en", `${stem}.mp3`))),
    );
    encodedAudios = files.map((buf) => buf.toString("base64"));
    emoAudio = encodedAudios[0];
  } catch {
    return NextResponse.json({ error: "有的英文配音文件不存在" }, { status: 400 });
  }

  const draftId = randomBytes(6).toString("hex");
  const gpuKey = `${speaker}-draft-${draftId}`;
  const dir = draftRoot(speaker, draftId);
  await pruneOldDrafts(speaker);
  await mkdir(dir, { recursive: true });

  try {
    const embedded = await gpuJson<EmbedResult>("/v1/speaker/embed", {
      speaker: gpuKey,
      audios: encodedAudios,
      audio_ids: stems,
      target_seconds: 15,
      gap_seconds: 0.12,
      trim_silence: true,
      prebatched: false,
    });
    await gpuJson("/v1/speaker/register", {
      speaker: gpuKey,
      embedding_pt_b64: embedded.embedding_pt_b64,
      reference_wav_b64: embedded.reference_wav_b64,
    });
    const lexicon = await sql<Pronunciation[]>`SELECT id, src, dst, note FROM pronunciations WHERE usage = 'reference'`;
    const candidates: { id: string; text: string; file: string; dur_s: number }[] = [];
    for (let i = 0; i < texts.length; i += 1) {
      const id = `c${String(i + 1).padStart(2, "0")}`;
      const sent = applyPronunciations(texts[i], lexicon);
      const generated = await gpuJson<{ audio_wav_b64: string }>("/v1/tts", {
        text: sent,
        speaker: gpuKey,
        emo_audio: emoAudio,
        emo_alpha: 0.4,
        duration_factor: 1,
        lang: "ZH",
        skip_seed_vc: true,
      });
      const audio = Buffer.from(generated.audio_wav_b64, "base64");
      const file = `${id}.wav`;
      await writeFile(path.join(dir, file), audio);
      const timing = wavTiming(audio);
      candidates.push({ id, text: texts[i], file, dur_s: timing.duration });
    }
    const manifest = {
      speaker,
      draftId,
      gpuKey,
      en_stems: stems,
      texts,
      candidates,
      created_at: new Date().toISOString(),
      tts_url: TTS_URL,
    };
    await Promise.all([
      writeFile(path.join(dir, "speaker.pt"), Buffer.from(embedded.embedding_pt_b64, "base64")),
      writeFile(path.join(dir, "source.wav"), Buffer.from(embedded.source_wav_b64, "base64")),
      writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    ]);
    return NextResponse.json({
      ok: true,
      draftId,
      candidates: candidates.map((row) => ({
        id: row.id,
        text: row.text,
        dur_s: row.dur_s,
        url: `/api/voices/${encodeURIComponent(speaker)}/embed/draft/${draftId}/${row.file}`,
      })),
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
