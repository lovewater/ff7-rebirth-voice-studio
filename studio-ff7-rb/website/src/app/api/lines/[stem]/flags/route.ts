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
  await sql`
    INSERT INTO line_meta (stem, skip_timing)
    VALUES (${stem}, ${body.skipTiming})
    ON CONFLICT (stem) DO UPDATE SET skip_timing = ${body.skipTiming}, updated_at = now()
  `;
  return NextResponse.json({ ok: true, skipTiming: body.skipTiming });
}
