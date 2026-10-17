import { copyFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { twoLineSubtitle } from "@/lib/auto-run-subtitle";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

function stemOk(stem: string) {
  return /^[\w.\-]+$/.test(stem);
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ stem: string }> },
) {
  const { stem } = await ctx.params;
  if (!stemOk(stem)) return NextResponse.json({ error: "bad stem" }, { status: 400 });
  const line = (
    await sql<{
      speaker: string | null;
      text_jp: string | null;
      text_zh: string | null;
      jp_start_s: number | null;
      jp_end_s: number | null;
      jp_dur_s: number | null;
      jp_speech_s: number | null;
    }[]>`
      SELECT l.speaker, l.text_jp, l.text_zh,
             m.jp_start_s, m.jp_end_s, m.jp_dur_s, m.jp_speech_s
      FROM lines l
      LEFT JOIN line_meta m ON m.stem = l.stem
      WHERE l.stem = ${stem}
    `
  )[0];
  if (!line) return NextResponse.json({ error: "台词不存在" }, { status: 404 });
  if (!line.speaker) return NextResponse.json({ error: "台词没有说话人" }, { status: 400 });
  const jpFile = path.join(process.cwd(), "data", "jp", `${stem}.mp3`);
  if (!existsSync(jpFile)) {
    return NextResponse.json({ error: "没有日文配音" }, { status: 400 });
  }
  const label = (line.text_zh || line.text_jp || "（日文原声）").trim() || "（日文原声）";
  const record = (
    await sql<{ id: string }[]>`
      INSERT INTO line_tts_versions (
        stem, speaker, voice_version_id, voice_gpu_key,
        tts_text, spoken_text, subtitle_text,
        jp_text_snapshot, game_zh_text_snapshot,
        duration_factor, emo_alpha
      ) VALUES (
        ${stem}, ${line.speaker}, NULL, ${"jp-lock"},
        ${label}, ${label}, ${line.text_zh == null ? null : twoLineSubtitle(line.text_zh)},
        ${line.text_jp}, ${line.text_zh},
        ${1}, ${0}
      )
      RETURNING id
    `
  )[0];
  const relativePath = path.posix.join("tts", stem, `${record.id}.mp3`);
  const absolutePath = path.join(process.cwd(), "data", relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await copyFile(jpFile, absolutePath);
  const fileStat = await stat(absolutePath);
  const conversion = { pipeline: "jp-lock", stem };
  await sql.begin(async (tx) => {
    await tx`
      UPDATE line_tts_versions
      SET is_used = false, used_at = NULL
      WHERE stem = ${stem} AND is_used
    `;
    await tx`
      UPDATE line_tts_versions SET
        status = 'ready',
        audio_path = ${relativePath},
        audio_bytes = ${fileStat.size},
        start_s = ${line.jp_start_s},
        end_s = ${line.jp_end_s},
        dur_s = ${line.jp_dur_s},
        speech_s = ${line.jp_speech_s},
        conversion_meta = ${sql.json(conversion)},
        is_used = true,
        used_at = now(),
        completed_at = now(),
        error = NULL
      WHERE id = ${record.id}
    `;
  });
  return NextResponse.json({ ok: true, id: record.id });
}
