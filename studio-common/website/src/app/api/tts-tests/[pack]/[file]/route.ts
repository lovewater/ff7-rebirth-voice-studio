import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ pack: string; file: string }> },
) {
  const { pack, file } = await ctx.params;
  if (!/^[\w.\-]+$/.test(pack) || !/^[\w.\-]+\.(wav|mp3|json)$/.test(file)) {
    return new Response("bad path", { status: 400 });
  }
  const abs = path.join(process.cwd(), "data", "tts-tests", pack, file);
  if (!existsSync(abs)) return new Response("not found", { status: 404 });
  const stream = createReadStream(abs);
  const type = file.endsWith(".json")
    ? "application/json"
    : file.endsWith(".mp3")
      ? "audio/mpeg"
      : "audio/wav";
  return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
    headers: { "content-type": type, "cache-control": "no-store" },
  });
}
