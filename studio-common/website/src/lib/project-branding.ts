import { readFile } from "node:fs/promises";
import path from "node:path";
import { gameProfile } from "./game-profile";

/** Shared deployment image, with each game's original icon selected at runtime. */
export async function projectIconResponse(format: "png" | "ico") {
  const game = gameProfile().id;
  const data = await readFile(path.join(process.cwd(), "public", "branding", `${game}.${format}`));
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": format === "png" ? "image/png" : "image/x-icon",
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
}
