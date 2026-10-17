import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; kind: string }> },
) {
  const { id, kind } = await ctx.params;
  const versionId = Number.parseInt(id, 10);
  if (!Number.isSafeInteger(versionId) || !["zh", "ja", "reference", "source"].includes(kind)) {
    return new Response("bad request", { status: 400 });
  }
  const rows = await sql<
    { example_zh_path: string | null; example_ja_path: string | null; reference_wav_path: string | null; source_wav_path: string | null }[]
  >`
    SELECT example_zh_path, example_ja_path, reference_wav_path, source_wav_path
    FROM voice_bank_versions WHERE id = ${versionId} AND status = 'ready'
  `;
  const row = rows[0];
  if (!row) return new Response("not found", { status: 404 });
  const relative = kind === "zh" ? row.example_zh_path : kind === "ja" ? row.example_ja_path : kind === "source" ? row.source_wav_path : row.reference_wav_path;
  if (!relative || relative.includes("..") || path.isAbsolute(relative)) {
    return new Response("missing", { status: 404 });
  }
  const file = path.join(process.cwd(), "data", relative);
  if (!existsSync(file)) return new Response("missing", { status: 404 });
  return new Response(Readable.toWeb(createReadStream(file)) as unknown as BodyInit, {
    headers: {
      "content-type": kind === "ja" ? "audio/mpeg" : "audio/wav",
      "cache-control": "no-store",
    },
  });
}
