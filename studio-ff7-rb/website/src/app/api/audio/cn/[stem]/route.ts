import { audioFileResponse } from "@/lib/audio-file-response";
import { NextRequest } from "next/server";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ stem: string }> },
) {
  const { stem } = await ctx.params;
  if (!/^[\w.\-]+$/.test(stem)) {
    return new Response("bad stem", { status: 400 });
  }
  const file = path.join(process.cwd(), "data", "cn", `${stem}.mp3`);
  return audioFileResponse(req, file, { contentType: "audio/mpeg", cacheControl: "no-store" });
}

export const HEAD = GET;
