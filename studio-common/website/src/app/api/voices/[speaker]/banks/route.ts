import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

function speakerOk(code: string) {
  return /^[\w.\-]+$/.test(code);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ speaker: string }> },
) {
  const { speaker } = await ctx.params;
  if (!speakerOk(speaker)) return NextResponse.json({ error: "bad speaker" }, { status: 400 });
  const next = await sql<{ slot: number }[]>`
    SELECT COALESCE(MAX(slot), 0) + 1 AS slot
    FROM voice_banks
    WHERE speaker = ${speaker} AND kind = '基准'
  `;
  const slot = next[0]?.slot ?? 1;
  await sql`
    INSERT INTO voice_banks (speaker, kind, slot, name)
    VALUES (${speaker}, '基准', ${slot}, ${"基准 " + slot})
  `;
  return NextResponse.json({ ok: true, slot });
}
