import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

function speakerOk(code: string) {
  return /^[\w.\-]+$/.test(code);
}

function noteText(value: unknown) {
  const note = typeof value === "string" ? value.trim() : "";
  if (note.length < 2 || note.length > 80) {
    throw new Error("备注必须写 2 到 80 个字，说明这条日文为什么适合当音色");
  }
  return note;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ speaker: string }> },
) {
  const { speaker } = await ctx.params;
  if (!speakerOk(speaker)) return NextResponse.json({ error: "bad speaker" }, { status: 400 });
  const body = (await req.json()) as {
    stem?: string;
    stems?: string[];
    selected?: boolean;
    note?: string;
  };
  const stems = body.stems ?? (body.stem ? [body.stem] : []);
  if (!stems.length) return NextResponse.json({ error: "no stems" }, { status: 400 });
  const owned = await sql<{ stem: string }[]>`
    SELECT stem FROM lines WHERE speaker = ${speaker} AND stem = ANY(${stems})
  `;
  if (owned.length !== stems.length) {
    return NextResponse.json({ error: "台词不属于这个人物" }, { status: 400 });
  }
  const selected = body.selected !== false;
  if (selected) {
    let note: string;
    try {
      note = noteText(body.note);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
    const maxOrd = (
      await sql<{ n: number | null }[]>`
        SELECT MAX(ordinal) AS n FROM speaker_timbre_refs WHERE speaker = ${speaker}
      `
    )[0]?.n ?? 0;
    for (let i = 0; i < stems.length; i += 1) {
      await sql`
        INSERT INTO speaker_timbre_refs (speaker, stem, ordinal, note)
        VALUES (${speaker}, ${stems[i]}, ${maxOrd + i + 1}, ${note})
        ON CONFLICT (speaker, stem) DO UPDATE SET note = EXCLUDED.note
      `;
    }
  } else {
    await sql`
      DELETE FROM speaker_timbre_refs
      WHERE speaker = ${speaker} AND stem = ANY(${stems})
    `;
  }
  const refs = await sql<{ stem: string; ordinal: number; note: string }[]>`
    SELECT stem, ordinal, note FROM speaker_timbre_refs
    WHERE speaker = ${speaker}
    ORDER BY ordinal, stem
  `;
  return NextResponse.json({ ok: true, refs });
}
