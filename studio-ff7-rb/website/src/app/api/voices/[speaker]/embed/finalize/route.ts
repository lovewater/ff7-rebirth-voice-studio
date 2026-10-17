import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { gpuJson } from "@/lib/tts-gpu";

export const dynamic = "force-dynamic";
export const maxDuration = 1200;

const TTS_URL = process.env.TTS_URL ?? "";

function speakerOk(code: string) {
  return /^[\w.\-]+$/.test(code);
}

type DraftManifest = {
  speaker: string;
  draftId: string;
  gpuKey: string;
  en_stems: string[];
  candidates: { id: string; text: string; file: string; dur_s: number }[];
};

type EmbedResult = {
  n_clips: number;
  batch_count: number;
  similarities: number[];
  manifest: Record<string, unknown>;
  embedding_pt_b64: string;
  reference_wav_b64: string;
  source_wav_b64: string;
};

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ speaker: string }> },
) {
  const { speaker } = await ctx.params;
  if (!speakerOk(speaker)) return NextResponse.json({ error: "bad speaker" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as {
    draftId?: string;
    candidateIds?: string[];
    slot?: number;
  };
  const draftId = typeof body.draftId === "string" ? body.draftId : "";
  const candidateIds = Array.isArray(body.candidateIds) ? body.candidateIds : [];
  if (!/^[a-f0-9]{12}$/.test(draftId)) {
    return NextResponse.json({ error: "没有有效的候选草稿" }, { status: 400 });
  }
  if (!candidateIds.length) {
    return NextResponse.json({ error: "至少勾选一条地道中文候选" }, { status: 400 });
  }
  const slot = Math.max(1, body.slot ?? 1);
  const draftDir = path.join(process.cwd(), "data", "embedded", speaker, "_drafts", draftId);
  let manifest: DraftManifest;
  try {
    manifest = JSON.parse(await readFile(path.join(draftDir, "manifest.json"), "utf8")) as DraftManifest;
  } catch {
    return NextResponse.json({ error: "草稿已过期，请重新生成候选" }, { status: 400 });
  }
  if (manifest.speaker !== speaker) {
    return NextResponse.json({ error: "草稿人物不匹配" }, { status: 400 });
  }
  const picked = candidateIds
    .map((id) => manifest.candidates.find((row) => row.id === id))
    .filter((row): row is DraftManifest["candidates"][number] => Boolean(row));
  if (picked.length !== candidateIds.length) {
    return NextResponse.json({ error: "有的候选不在这次草稿里" }, { status: 400 });
  }
  const totalDur = picked.reduce((sum, row) => sum + (row.dur_s ?? 0), 0);
  if (totalDur > 15) {
    return NextResponse.json({ error: "选中的中文候选总长不能超过 15 秒" }, { status: 400 });
  }

  const bank = (
    await sql<{ id: number }[]>`
      INSERT INTO voice_banks (speaker, kind, slot, name)
      VALUES (${speaker}, '基准', ${slot}, ${"基准 " + slot})
      ON CONFLICT (speaker, kind, slot) DO UPDATE SET name = voice_banks.name
      RETURNING id
    `
  )[0];
  if (!bank) return NextResponse.json({ error: "无法创建基准槽" }, { status: 500 });

  const health = await gpuJson<{
    model_version?: string;
    model_revision?: string;
    source_revision?: string;
    package_version?: string;
    precision?: string;
    device?: string;
  }>("/health", undefined, 30_000);

  const version = (
    await sql<{ id: number }[]>`
      INSERT INTO voice_bank_versions (
        bank_id, status, source_lang, n_clips, total_dur_s,
        engine_model_version, engine_model_revision, engine_source_revision,
        engine_package_version, engine_precision, engine_device, engine_url
      ) VALUES (
        ${bank.id}, 'building', 'cn', ${picked.length}, ${totalDur},
        ${health.model_version ?? null}, ${health.model_revision ?? null},
        ${health.source_revision ?? null}, ${health.package_version ?? null},
        ${health.precision ?? null}, ${health.device ?? null}, ${TTS_URL}
      )
      RETURNING id
    `
  )[0];

  const gpuKey = `${speaker}-v${version.id}`;
  const relativeDir = path.posix.join("embedded", speaker, `v${version.id}`);
  const absoluteDir = path.join(process.cwd(), "data", relativeDir);

  try {
    const wavs = await Promise.all(
      picked.map((row) => readFile(path.join(draftDir, row.file))),
    );
    const embedded = await gpuJson<EmbedResult>("/v1/speaker/embed", {
      speaker: gpuKey,
      audios: wavs.map((buf) => buf.toString("base64")),
      audio_ids: picked.map((row) => row.id),
      target_seconds: 15,
      gap_seconds: 0.12,
      trim_silence: true,
      prebatched: false,
    });
    await mkdir(absoluteDir, { recursive: true });
    const embeddingPath = path.posix.join(relativeDir, "speaker.pt");
    const sourcePath = path.posix.join(relativeDir, "source.wav");
    const referencePath = path.posix.join(relativeDir, "reference.wav");
    const manifestPath = path.posix.join(relativeDir, "manifest.json");
    const stored = {
      ...embedded.manifest,
      pipeline: "en-style-zh-pick",
      version_id: version.id,
      speaker,
      en_stems: manifest.en_stems,
      picked,
      gpu_speaker_key: gpuKey,
    };
    await Promise.all([
      writeFile(path.join(process.cwd(), "data", embeddingPath), Buffer.from(embedded.embedding_pt_b64, "base64")),
      writeFile(path.join(process.cwd(), "data", sourcePath), Buffer.from(embedded.source_wav_b64, "base64")),
      writeFile(path.join(process.cwd(), "data", referencePath), Buffer.from(embedded.reference_wav_b64, "base64")),
      writeFile(path.join(process.cwd(), "data", manifestPath), `${JSON.stringify(stored, null, 2)}\n`),
      ...picked.map((row, index) =>
        writeFile(path.join(absoluteDir, `picked-${String(index + 1).padStart(2, "0")}.wav`), wavs[index]),
      ),
    ]);
    const similarities = embedded.similarities.length ? embedded.similarities : [1];
    await sql`
      UPDATE voice_bank_versions SET
        status = 'ready', gpu_speaker_key = ${gpuKey},
        n_clips = ${picked.length}, total_dur_s = ${totalDur},
        embedding_path = ${embeddingPath}, reference_wav_path = ${referencePath},
        source_wav_path = ${sourcePath},
        result_dir = ${relativeDir}, manifest_path = ${manifestPath},
        batch_count = ${embedded.batch_count},
        similarity_min = ${Math.min(...similarities)},
        similarity_mean = ${similarities.reduce((a, b) => a + b, 0) / similarities.length},
        similarity_max = ${Math.max(...similarities)},
        completed_at = now(), error = NULL
      WHERE id = ${version.id}
    `;
    await rm(draftDir, { recursive: true, force: true }).catch(() => undefined);
    return NextResponse.json({ ok: true, versionId: version.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      UPDATE voice_bank_versions
      SET status = 'failed', error = ${message}, completed_at = now()
      WHERE id = ${version.id}
    `;
    return NextResponse.json({ error: message, versionId: version.id }, { status: 500 });
  }
}
