import { audioFileResponse } from "@/lib/audio-file-response";
import path from "node:path";
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ stem: string; id: string }> },
) {
  const { stem, id } = await ctx.params;
  if (!/^[\w.\-]+$/.test(stem) || !/^\d+$/.test(id)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const record = (
    await sql<{ audio_path: string | null; raw_audio_path: string | null }[]>`
      SELECT v.audio_path, v.raw_audio_path
      FROM line_tts_versions v
      WHERE v.id = ${Number(id)} AND v.stem = ${stem} AND v.status = 'ready'
    `
  )[0];
  const kind = new URL(req.url).searchParams.get("kind");
  // 手动比较和编辑始终使用完整日文原声，保留拟声、停顿及完整演出时间轴。
  // 裁后参考只供自动 TTS/语速检查使用，其文件和数据库记录仍保留，不作为编辑对照源。
  const relative = kind === "reference" ? record && `jp/${stem}.mp3`
    : kind === "raw" ? record?.raw_audio_path : record?.audio_path;
  if (!relative) return NextResponse.json({ error: "音频不存在" }, { status: 404 });

  const dataRoot = path.resolve(process.cwd(), "data", kind === "reference" ? "jp" : "tts");
  const target = path.resolve(process.cwd(), "data", relative);
  if (!target.startsWith(`${dataRoot}${path.sep}`)) {
    return NextResponse.json({ error: "非法路径" }, { status: 400 });
  }
  try {
    const ext = path.extname(target).toLowerCase();
    const contentType = ext === ".mp3" ? "audio/mpeg" : "audio/wav";
    return await audioFileResponse(req, target, {
      contentType,
      headers: kind === "reference" ? { "x-reference-kind": "original" } : undefined,
    });
  } catch {
    return NextResponse.json({ error: "音频文件不存在" }, { status: 404 });
  }
}

export const HEAD = GET;
