import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { twoLineSubtitle } from "@/lib/auto-run-subtitle";
import { sql } from "@/lib/db";
import { measureSavedEdit } from "@/lib/speech-metrics-store";
import { wavTiming } from "@/lib/tts-gpu";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function valid(stem: string, id: string) {
  return /^[\w.\-]+$/.test(stem) && /^\d+$/.test(id);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ stem: string; id: string }> },
) {
  const { stem, id } = await ctx.params;
  if (!valid(stem, id)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { wavBase64?: string };
  const b64 = typeof body.wavBase64 === "string" ? body.wavBase64.replace(/^data:audio\/wav;base64,/, "") : "";
  if (!b64) return NextResponse.json({ error: "缺少编辑后的 WAV" }, { status: 400 });
  let audio: Buffer;
  try {
    audio = Buffer.from(b64, "base64");
  } catch {
    return NextResponse.json({ error: "WAV 编码无效" }, { status: 400 });
  }
  if (audio.length < 44 || audio.length > 20_000_000) {
    return NextResponse.json({ error: "WAV 体积不合法" }, { status: 400 });
  }
  let timing: { start: number; end: number; duration: number; speech: number };
  try {
    timing = wavTiming(audio);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "无法读取 WAV" },
      { status: 400 },
    );
  }
  const source = (
    await sql<{
      speaker: string;
      tts_text: string;
      spoken_text: string;
      subtitle_text: string | null;
      jp_text_snapshot: string | null;
      game_zh_text_snapshot: string | null;
      duration_factor: number;
    }[]>`
      SELECT speaker, tts_text, spoken_text, subtitle_text,
             jp_text_snapshot, game_zh_text_snapshot, duration_factor
      FROM line_tts_versions
      WHERE id = ${Number(id)} AND stem = ${stem} AND status = 'ready'
    `
  )[0];
  if (!source) return NextResponse.json({ error: "源记录不存在" }, { status: 404 });
  const record = (
    await sql<{ id: string }[]>`
      INSERT INTO line_tts_versions (
        stem, speaker, voice_version_id, voice_gpu_key,
        tts_text, spoken_text, subtitle_text,
        jp_text_snapshot, game_zh_text_snapshot,
        duration_factor, emo_alpha
      ) VALUES (
        ${stem}, ${source.speaker}, NULL, ${"audio-edit"},
        ${source.tts_text}, ${source.spoken_text}, ${source.subtitle_text == null ? null : twoLineSubtitle(source.subtitle_text)},
        ${source.jp_text_snapshot}, ${source.game_zh_text_snapshot},
        ${source.duration_factor}, ${0}
      )
      RETURNING id
    `
  )[0];
  const relativePath = path.posix.join("tts", stem, `${record.id}.wav`);
  const absolutePath = path.join(process.cwd(), "data", relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, audio);
  const conversion = { pipeline: "audio-edit", source_id: Number(id), stem };
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
  const net = await measureSavedEdit(stem, String(record.id));
  return NextResponse.json({ ok: true, id: record.id, ...net });
}
