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
  let slot = 1;
  try {
    const body = (await req.json()) as { slot?: number };
    if (body.slot) slot = Math.max(1, body.slot | 0);
  } catch {
    /* default slot 1 */
  }

  await sql`
    INSERT INTO voice_banks (speaker, kind, slot, name)
    VALUES (${speaker}, '基准', ${slot}, ${"基准 " + slot})
    ON CONFLICT (speaker, kind, slot) DO NOTHING
  `;
  const bank = (
    await sql<{ id: number }[]>`
      SELECT id FROM voice_banks
      WHERE speaker = ${speaker} AND kind = '基准' AND slot = ${slot}
    `
  )[0];
  if (!bank) return NextResponse.json({ error: "no bank" }, { status: 500 });

  const found = await sql<
    { stem: string; dur: number }[]
  >`
    SELECT l.stem,
           COALESCE(m.jp_dur_s, m.jp_speech_s, 0)::float AS dur
    FROM lines l
    JOIN line_meta m ON m.stem = l.stem
    WHERE l.speaker = ${speaker}
      AND COALESCE(m.jp_dur_s, m.jp_speech_s, 0) > 0
    ORDER BY dur DESC, l.stem
  `;

  const pool = found.filter((row) => row.dur > 1.5);

  const sumOf = (min: number) =>
    pool.filter((r) => r.dur > min).reduce((a, r) => a + r.dur, 0);
  let minDur = 3;
  if (sumOf(3) >= 60) minDur = 3;
  else if (sumOf(2) >= 60) minDur = 2;
  else minDur = 1.5;
  const picked = pool.filter((r) => r.dur > minDur);
  const dur = picked.reduce((a, r) => a + r.dur, 0);
  const shortfall = dur < 60;
  const stems = picked.map((r) => r.stem);
  const allStems = found.map((r) => r.stem);

  await sql`DELETE FROM voice_bank_draft_clips WHERE bank_id = ${bank.id}`;
  if (allStems.length) {
    await sql`
      INSERT INTO voice_bank_draft_clips (bank_id, stem, selected, recommended)
      SELECT ${bank.id}, x, x = ANY(${stems}::text[]), x = ANY(${stems}::text[])
      FROM unnest(${allStems}::text[]) AS x
    `;
  }

  return NextResponse.json({
    ok: true,
    speaker,
    slot,
    n: stems.length,
    total: allStems.length,
    minDur,
    shortfall,
    source: "duration",
    n3: pool.filter((r) => r.dur > 3).length,
    dur3: Math.round(sumOf(3) * 10) / 10,
    n2: pool.filter((r) => r.dur > 2).length,
    dur2: Math.round(sumOf(2) * 10) / 10,
    n15: pool.filter((r) => r.dur > 1.5).length,
    dur15: Math.round(sumOf(1.5) * 10) / 10,
    dur: Math.round(dur * 10) / 10,
  });
}
