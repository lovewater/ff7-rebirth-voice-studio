import path from "node:path";
import { sql } from "@/lib/db";
import { audioFileResponse } from "@/lib/audio-file-response";

export const dynamic = "force-dynamic";

/** 专供实验试听实际送入TTS的裁后日文；详情页的完整日文比较规则不受影响。 */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) return new Response("bad id", { status: 400 });
  const [row] = await sql<{ reference_audio_path: string | null }[]>`
    SELECT reference_audio_path FROM line_auto_runs WHERE id=${Number(id)}
  `;
  if (!row?.reference_audio_path) return new Response("reference not found", { status: 404 });
  const root = path.resolve(process.cwd(), "data", "tts");
  const file = path.resolve(process.cwd(), "data", row.reference_audio_path);
  if (!file.startsWith(root + path.sep)) return new Response("invalid reference path", { status: 400 });
  return audioFileResponse(req, file, { contentType: "audio/wav" });
}

export const HEAD = GET;
