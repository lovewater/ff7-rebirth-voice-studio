import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { twoLineSubtitle } from "@/lib/auto-run-subtitle";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

/** 原中文也能在手机审核中锁定/标异常。首次操作才保存一条原声副本，复用三态，
 * 不改字幕、不调用TTS，原“忽略对时”入口也统一落为这条原中文的锁定。
 */
export async function POST(req: Request, ctx: { params: Promise<{ stem: string }> }) {
  const { stem } = await ctx.params;
  if (!/^[\w.\-]+$/.test(stem)) return NextResponse.json({ error: "bad stem" }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body || !["locked", "abnormal"].includes(body.reviewState)) return NextResponse.json({ error: "需要锁定或异常状态" }, { status: 400 });
  const source = path.join(process.cwd(), "data", "cn", `${stem}.mp3`);
  try { await stat(source); } catch { return NextResponse.json({ error: "没有原中文音频" }, { status: 404 }); }
  const result = await sql.begin(async tx => {
    const [line] = await tx<{ speaker: string | null; text_jp: string | null; text_zh: string | null }[]>`
      SELECT speaker, text_jp, text_zh FROM lines WHERE stem=${stem} FOR UPDATE`;
    if (!line?.speaker) return null;
    const [timing] = await tx<{ cn_start_s: number | null; cn_end_s: number | null; cn_dur_s: number | null; cn_speech_s: number | null }[]>`
      SELECT cn_start_s,cn_end_s,cn_dur_s,cn_speech_s FROM line_meta WHERE stem=${stem}`;
    let [record] = await tx<{ id: string }[]>`SELECT id::text AS id FROM line_tts_versions
      WHERE stem=${stem} AND status='ready' AND voice_gpu_key='cn-original' ORDER BY id DESC LIMIT 1`;
    if (!record) {
      [record] = await tx<{ id: string }[]>`INSERT INTO line_tts_versions
        (stem,speaker,voice_gpu_key,tts_text,spoken_text,jp_text_snapshot,game_zh_text_snapshot,duration_factor,emo_alpha)
        VALUES(${stem},${line.speaker},'cn-original',${line.text_zh || '（原中文）'},${line.text_zh || '（原中文）'},${line.text_jp},${line.text_zh},1,0)
        RETURNING id::text AS id`;
      const relative = path.posix.join("tts", stem, `${record.id}.mp3`);
      const file = path.join(process.cwd(), "data", relative);
      await mkdir(path.dirname(file), { recursive: true });
      await copyFile(source, file);
      const info = await stat(file);
      await tx`UPDATE line_tts_versions SET status='ready',audio_path=${relative},audio_bytes=${info.size},
        start_s=${timing?.cn_start_s ?? null},end_s=${timing?.cn_end_s ?? null},dur_s=${timing?.cn_dur_s ?? null},speech_s=${timing?.cn_speech_s ?? null},
        conversion_meta=${sql.json({ pipeline: "cn-original", stem })},completed_at=now() WHERE id=${record.id}`;
    }
    await tx`UPDATE line_tts_versions SET review_state='candidate',used_at=NULL WHERE stem=${stem} AND review_state IN ('locked','abnormal')`;
    await tx`UPDATE line_tts_versions SET review_state=${body.reviewState},used_at=CASE WHEN ${body.reviewState}='locked' THEN now() ELSE NULL END WHERE id=${record.id}`;
    // 核对字幕与锁定在同一事务保存，手机未传字幕时仍沿用已有原字幕。
    if (Object.prototype.hasOwnProperty.call(body, "subtitleText")) {
      const subtitle = typeof body.subtitleText === "string" ? twoLineSubtitle(body.subtitleText) || null : null;
      await tx`UPDATE line_tts_versions SET subtitle_text=${subtitle} WHERE id=${record.id}`;
    }
    return record;
  });
  return result ? NextResponse.json({ ok: true, id: result.id }) : NextResponse.json({ error: "台词不存在或缺少说话人" }, { status: 400 });
}
