import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { NextRequest } from "next/server";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ stem: string }> },
) {
  const { stem } = await ctx.params;
  if (!/^[\w.\-]+$/.test(stem)) {
    return new Response("bad stem", { status: 400 });
  }
  const file = path.join(process.cwd(), "data", "cn", `${stem}.mp3`);
  if (!existsSync(file)) {
    return new Response("not extracted", { status: 404 });
  }
  const stream = createReadStream(file);
  return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "no-store",
    },
  });
}
