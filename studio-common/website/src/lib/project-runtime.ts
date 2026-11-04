import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gameProfile, projectDatabaseUrl, type GameEnvironment } from "./game-profile";

/** Refuse an accidental Rebirth audio bind even when the Remake database is correct. */
export function projectRuntime(env: GameEnvironment = process.env, dataRoot = path.join(process.cwd(), "data")) {
  const profile = gameProfile(env);
  const databaseUrl = projectDatabaseUrl(env);
  const file = path.join(dataRoot, ".ff7-game.json");
  if (profile.id === "rebirth" && !existsSync(file)) return { profile, databaseUrl };
  let marker: { game_id?: unknown; database?: unknown };
  try { marker = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("游戏音频目录缺少有效的 .ff7-game.json 标识"); }
  if (!marker || marker.game_id !== profile.id
    || (profile.id === "remake" && marker.database !== "studio_ff7_remake")) {
    throw new Error("游戏音频目录标识与当前站点不一致，拒绝启动");
  }
  return { profile, databaseUrl };
}
