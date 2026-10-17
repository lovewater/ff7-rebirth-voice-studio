import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { twoLineSubtitle } from "@/lib/auto-run-subtitle";
import { sql } from "@/lib/db";
import { measureSavedEdit } from "@/lib/speech-metrics-store";
import { wavTiming } from "@/lib/tts-gpu";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function stemOk(stem: string) {
  return /^[\w.\-]+$/.test(stem);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ stem: string }> },
) {
  const { stem } = await ctx.params;
  if (!stemOk(stem)) return NextResponse.json({ error: "bad stem" }, { status: 400 });
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
  const line = (
    await sql<{ speaker: string | null; text_jp: string | null; text_zh: string | null }[]>`
      SELECT speaker, text_jp, text_zh FROM lines WHERE stem = ${stem}
    `
  )[0];
  if (!line) return NextResponse.json({ error: "台词不存在" }, { status: 404 });
  if (!line.speaker) return NextResponse.json({ error: "台词没有说话人" }, { status: 400 });
  const label = (line.text_zh || line.text_jp || "（中文原声编辑）").trim() || "（中文原声编辑）";
  const record = (
    await sql<{ id: string }[]>`
      INSERT INTO line_tts_versions (
        stem, speaker, voice_version_id, voice_gpu_key,
        tts_text, spoken_text, subtitle_text,
        jp_text_snapshot, game_zh_text_snapshot,
        duration_factor, emo_alpha
      ) VALUES (
        ${stem}, ${line.speaker}, NULL, ${"cn-edit"},
        ${label}, ${label}, ${line.text_zh == null ? null : twoLineSubtitle(line.text_zh)},
        ${line.text_jp}, ${line.text_zh},
        ${1}, ${0}
      )
      RETURNING id
    `
  )[0];
  const relativePath = path.posix.join("tts", stem, `${record.id}.wav`);
  const absolutePath = path.join(process.cwd(), "data", relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, audio);
  const conversion = { pipeline: "cn-edit", stem };
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
