export type GameId = "rebirth" | "remake";
export type GameEnvironment = { [key: string]: string | undefined; FF7_GAME_ID?: string; GAME_ID?: string; DATABASE_URL?: string };

const profiles = {
  rebirth: { id: "rebirth", name: "FF7 Rebirth", title: "FF7 Rebirth 中文配音修订台", description: "修订现成中文语音包", extractionReady: true, sourceOriginalChineseAudio: true },
  remake: { id: "remake", name: "FF7 Remake", title: "FF7 Remake 中文配音修订台", description: "FF7 Remake 中文配音修订", extractionReady: false, sourceOriginalChineseAudio: false },
} as const;

/** Server-only configuration: pass the resulting display strings to client components. */
export function gameProfile(env: GameEnvironment = process.env) {
  if (env.FF7_GAME_ID && env.GAME_ID && env.FF7_GAME_ID !== env.GAME_ID) {
    throw new Error("FF7_GAME_ID 与 GAME_ID 不一致");
  }
  const id = env.FF7_GAME_ID ?? env.GAME_ID ?? "rebirth";
  if (id !== "rebirth" && id !== "remake") throw new Error("不支持的 FF7_GAME_ID");
  return profiles[id];
}

/** A Remake instance must never inherit the legacy Rebirth database fallback. */
export function projectDatabaseUrl(env: GameEnvironment = process.env) {
  const profile = gameProfile(env);
  if (profile.id === "remake" && !env.DATABASE_URL) throw new Error("Remake 必须显式配置独立 DATABASE_URL");
  const configured = env.DATABASE_URL ?? "postgres://ff7rb@127.0.0.1:25432/studio";
  let url: URL;
  let database: string;
  let username: string;
  try {
    url = new URL(configured);
    database = decodeURIComponent(url.pathname);
    username = decodeURIComponent(url.username);
  } catch { throw new Error("DATABASE_URL 格式无效"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || [...url.searchParams.keys()].some(key => ["database", "db", "dbname", "user", "username"].includes(key.toLowerCase()))) {
    throw new Error("DATABASE_URL 不允许通过查询参数覆盖数据库或账号");
  }
  if (profile.id === "rebirth") {
    if (database === "/studio_ff7_remake" || username === "ff7remake") {
      throw new Error("Rebirth 不能使用 Remake 保留数据库或账号");
    }
    return configured;
  }
  if (database !== "/studio_ff7_remake" || username !== "ff7remake") {
    throw new Error("Remake 必须使用 studio_ff7_remake 数据库和 ff7remake 独立账号");
  }
  return configured;
}

export function projectReadiness(lineCount: number, env: GameEnvironment = process.env) {
  const profile = gameProfile(env);
  return {
    game: profile.id,
    name: profile.name,
    title: profile.title,
    status: lineCount > 0 ? "imported" : "awaiting-import",
    lineCount,
    extractionReady: profile.extractionReady,
    sourceOriginalChineseAudio: profile.sourceOriginalChineseAudio,
  } as const;
}

/** Remote speaker artifacts share a GPU filesystem, unlike each game's local DB. */
export function projectGpuSpeakerKey(key: string, env: GameEnvironment = process.env) {
  if (gameProfile(env).id === "rebirth") return key;
  return key.startsWith("remake-") ? key : `remake-${key}`;
}
