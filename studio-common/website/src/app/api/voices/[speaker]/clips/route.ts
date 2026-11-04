import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

function speakerOk(code: string) {
  return /^[\w.\-]+$/.test(code);
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ speaker: string }> },
) {
  const { speaker } = await ctx.params;
  if (!speakerOk(speaker)) return NextResponse.json({ error: "bad speaker" }, { status: 400 });
  const body = (await req.json()) as {
    slot?: number;
    stem?: string;
    stems?: string[];
    selected: boolean;
  };
  const slot = Math.max(1, body.slot ?? 1);
  const stems = body.stems ?? (body.stem ? [body.stem] : []);
  if (!stems.length) return NextResponse.json({ error: "no stems" }, { status: 400 });

  const bank = (
    await sql<{ id: number }[]>`
      SELECT id FROM voice_banks
      WHERE speaker = ${speaker} AND kind = '基准' AND slot = ${slot}
    `
  )[0];
  if (!bank) return NextResponse.json({ error: "no bank, scan first" }, { status: 400 });

  await sql`
    UPDATE voice_bank_draft_clips
    SET selected = ${body.selected}
    WHERE bank_id = ${bank.id} AND stem = ANY(${stems})
  `;
  return NextResponse.json({ ok: true });
}
