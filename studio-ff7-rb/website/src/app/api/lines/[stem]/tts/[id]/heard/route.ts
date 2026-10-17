import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

function valid(stem: string, id: string) {
  return /^[\w.\-]+$/.test(stem) && /^\d+$/.test(id);
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ stem: string; id: string }> },
) {
  const { stem, id } = await ctx.params;
  if (!valid(stem, id)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const updated = (
    await sql<{ id: string; heard_at: string; play_count: number }[]>`
      UPDATE line_tts_versions
      -- 首次试听时间保持原样，每次上报直接原子加一，不做是否成功播放的推断。
      SET heard_at = COALESCE(heard_at, now()), play_count = play_count + 1
      WHERE id = ${Number(id)} AND stem = ${stem} AND status = 'ready'
      RETURNING id::text AS id, heard_at::text, play_count
    `
  )[0];
  if (!updated) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
  return NextResponse.json({ ok: true, heardAt: updated.heard_at, playCount: updated.play_count });
}
