import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { parseTtsDefaults } from "@/lib/tts-defaults";

export const dynamic = "force-dynamic";

function speakerOk(code: string) {
  return /^[\w.\-]+$/.test(code);
}

async function ensureBase(speaker: string, slot = 1) {
  await sql`
    INSERT INTO voice_banks (speaker, kind, slot, name)
    VALUES (${speaker}, '基准', ${slot}, ${"基准 " + slot})
    ON CONFLICT (speaker, kind, slot) DO NOTHING
  `;
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM voice_banks
    WHERE speaker = ${speaker} AND kind = '基准' AND slot = ${slot}
  `;
  return rows[0].id;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ speaker: string }> },
) {
  const { speaker } = await ctx.params;
  if (!speakerOk(speaker)) return NextResponse.json({ error: "bad speaker" }, { status: 400 });
  const slot = Math.max(1, parseInt(req.nextUrl.searchParams.get("slot") ?? "1", 10) || 1);
  await ensureBase(speaker, slot);

  const banks = await sql<
    { id: number; kind: string; slot: number; name: string | null }[]
  >`
    SELECT id, kind, slot, name FROM voice_banks
    WHERE speaker = ${speaker}
    ORDER BY CASE kind WHEN '基准' THEN 0 ELSE 1 END, slot, kind
  `;
  const bank = banks.find((b) => b.kind === "基准" && b.slot === slot) ?? banks.find((b) => b.kind === "基准");
  if (!bank) return NextResponse.json({ error: "no bank" }, { status: 500 });

  const clips = await sql<
    {
      stem: string;
      selected: boolean;
      recommended: boolean;
      text_zh: string | null;
      text_jp: string | null;
      region: string | null;
      region_name: string | null;
      jp_dur_s: number | null;
      cn_dur_s: number | null;
      en_dur_s: number | null;
      jp_speech_s: number | null;
    }[]
  >`
    SELECT d.stem, d.selected, d.recommended, l.text_zh, l.text_jp,
           l.region, COALESCE(r.name_zh, l.region) AS region_name,
           m.jp_dur_s, m.cn_dur_s, m.en_dur_s, m.jp_speech_s
    FROM voice_bank_draft_clips d
    JOIN lines l ON l.stem = d.stem
    LEFT JOIN line_meta m ON m.stem = d.stem
    LEFT JOIN regions r ON r.code = l.region
    WHERE d.bank_id = ${bank.id}
    ORDER BY d.recommended DESC,
             COALESCE(m.jp_dur_s, m.jp_speech_s, 0) DESC,
             l.stem
  `;

  const versions = await sql<
    {
      id: number;
      created_at: string;
      completed_at: string | null;
      status: string;
      source_lang: "jp" | "cn" | "en";
      n_clips: number;
      total_dur_s: number | null;
      batch_count: number | null;
      similarity_min: number | null;
      similarity_mean: number | null;
      similarity_max: number | null;
      result_dir: string | null;
      embedding_path: string | null;
      reference_wav_path: string | null;
      source_wav_path: string | null;
      manifest_path: string | null;
      example_stem: string | null;
      example_emo_alpha: number | null;
      example_text_zh: string | null;
      example_text_jp: string | null;
      error: string | null;
      engine_model_version: string | null;
      engine_model_revision: string | null;
      engine_source_revision: string | null;
      engine_package_version: string | null;
      engine_precision: string | null;
      engine_device: string | null;
      engine_url: string | null;
    }[]
  >`
    SELECT v.id, v.created_at, v.completed_at, v.status, v.source_lang,
           v.n_clips, v.total_dur_s, v.batch_count,
           v.similarity_min, v.similarity_mean, v.similarity_max,
           v.result_dir, v.embedding_path, v.reference_wav_path, v.source_wav_path, v.manifest_path,
           v.example_stem, v.example_emo_alpha,
           l.text_zh AS example_text_zh, l.text_jp AS example_text_jp,
           v.error, v.engine_model_version, v.engine_model_revision,
           v.engine_source_revision, v.engine_package_version,
           v.engine_precision, v.engine_device, v.engine_url
    FROM voice_bank_versions v
    LEFT JOIN lines l ON l.stem = v.example_stem
    WHERE v.bank_id = ${bank.id}
    ORDER BY v.created_at DESC
  `;

  const [speakerRow] = await sql<{ tts_defaults: unknown }[]>`
    SELECT tts_defaults FROM speakers WHERE code = ${speaker}
  `;
  const timbreClips = await sql<
    {
      id: number;
      stem: string;
      text_zh: string | null;
      text_jp: string | null;
      region: string | null;
      region_name: string | null;
      jp_dur_s: number | null;
      en_dur_s: number | null;
      timbre: boolean;
      note: string | null;
    }[]
  >`
    SELECT l.id, l.stem, l.text_zh, l.text_jp, l.region,
           COALESCE(r.name_zh, l.region) AS region_name,
           m.jp_dur_s, m.en_dur_s,
           (t.stem IS NOT NULL) AS timbre,
           t.note
    FROM lines l
    LEFT JOIN line_meta m ON m.stem = l.stem
    LEFT JOIN regions r ON r.code = l.region
    LEFT JOIN speaker_timbre_refs t ON t.speaker = ${speaker} AND t.stem = l.stem
    WHERE l.speaker = ${speaker}
      AND COALESCE(m.jp_dur_s, m.jp_speech_s, 0) > 0
    ORDER BY t.stem IS NOT NULL DESC, COALESCE(m.jp_dur_s, 0) DESC, l.stem
  `;

  const enSourceClips = await sql<
    {
      stem: string;
      text_zh: string | null;
      text_en: string | null;
      text_jp: string | null;
      region: string | null;
      region_name: string | null;
      en_dur_s: number | null;
    }[]
  >`
    SELECT l.stem, l.text_zh, l.text_en, l.text_jp, l.region,
           COALESCE(r.name_zh, l.region) AS region_name,
           m.en_dur_s
    FROM lines l
    LEFT JOIN line_meta m ON m.stem = l.stem
    LEFT JOIN regions r ON r.code = l.region
    WHERE l.speaker = ${speaker}
      AND COALESCE(m.en_dur_s, 0) > 0
    ORDER BY m.en_dur_s DESC, l.stem
  `;

  return NextResponse.json({
    speaker,
    slot,
    bank,
    banks: banks.filter((b) => b.kind === "基准"),
    clips,
    versions,
    tts_defaults: parseTtsDefaults(speakerRow?.tts_defaults),
    timbre_clips: timbreClips,
    en_source_clips: enSourceClips,
  });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ speaker: string }> },
) {
  const { speaker } = await ctx.params;
  if (!speakerOk(speaker)) return NextResponse.json({ error: "bad speaker" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { tts_defaults?: unknown };
  const defaults = parseTtsDefaults(body.tts_defaults);
  if (defaults.voice_version_id != null) {
    const [owned] = await sql<{ id: number }[]>`
      SELECT v.id FROM voice_bank_versions v
      JOIN voice_banks b ON b.id = v.bank_id
      WHERE v.id = ${defaults.voice_version_id} AND b.speaker = ${speaker} AND v.status = 'ready'
    `;
    if (!owned) return NextResponse.json({ error: "默认 embedding 不属于这个人物" }, { status: 400 });
  }
  await sql`
    UPDATE speakers SET tts_defaults = ${sql.json(defaults)}, updated_at = now()
    WHERE code = ${speaker}
  `;
  return NextResponse.json({ ok: true, tts_defaults: defaults });
}
