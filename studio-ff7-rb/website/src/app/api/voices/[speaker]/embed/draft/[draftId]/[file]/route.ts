import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ speaker: string; draftId: string; file: string }> },
) {
  const { speaker, draftId, file } = await ctx.params;
  if (!/^[\w.\-]+$/.test(speaker) || !/^[a-f0-9]{12}$/.test(draftId) || !/^c\d{2}\.wav$/.test(file)) {
    return new Response("bad path", { status: 400 });
  }
  const abs = path.join(process.cwd(), "data", "embedded", speaker, "_drafts", draftId, file);
  if (!existsSync(abs)) return new Response("not found", { status: 404 });
  const stream = createReadStream(abs);
  return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
    headers: {
      "content-type": "audio/wav",
      "cache-control": "no-store",
    },
  });
}
