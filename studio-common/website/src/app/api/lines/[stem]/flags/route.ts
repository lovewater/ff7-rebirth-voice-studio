import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

function stemOk(stem: string) {
  return /^[\w.\-]+$/.test(stem);
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ stem: string }> },
) {
  const { stem } = await ctx.params;
  if (!stemOk(stem)) return NextResponse.json({ error: "bad stem" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { skipTiming?: boolean };
  if (typeof body.skipTiming !== "boolean") {
    return NextResponse.json({ error: "需要 skipTiming" }, { status: 400 });
  }
  const exists = (await sql<{ stem: string }[]>`SELECT stem FROM lines WHERE stem = ${stem}`)[0];
  if (!exists) return NextResponse.json({ error: "台词不存在" }, { status: 404 });
  if (body.skipTiming) {
    const { POST } = await import("../original-review/route");
    return POST(new Request(req.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewState: "locked" }) }), ctx);
  }
  await sql.begin(async tx => {
    await tx`SELECT stem FROM lines WHERE stem=${stem} FOR UPDATE`;
    await tx`UPDATE line_tts_versions SET review_state='candidate',used_at=NULL
      WHERE stem=${stem} AND review_state='locked' AND voice_gpu_key='cn-original'`;
  });
  return NextResponse.json({ ok: true, skipTiming: false });
}
