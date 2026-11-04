import { gameProfile } from "@/lib/game-profile";
import { audioFileResponse } from "@/lib/audio-file-response";
import { NextRequest } from "next/server";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ stem: string }> },
) {
  if (!gameProfile().sourceOriginalChineseAudio) return new Response(JSON.stringify({error:"本游戏没有原始中文配音"}), {status:404,headers:{"content-type":"application/json"}});
  const { stem } = await ctx.params;
  if (!/^[\w.\-]+$/.test(stem)) {
    return new Response("bad stem", { status: 400 });
  }
  const file = path.join(process.cwd(), "data", "cn", `${stem}.mp3`);
  return audioFileResponse(req, file, { contentType: "audio/mpeg", cacheControl: "no-store" });
}

export const HEAD = GET;
