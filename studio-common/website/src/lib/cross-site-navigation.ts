import type { GameId } from "./game-profile";

export function otherGameUrl(origin: string, pathname: string, gameId: GameId) {
  const url = new URL(origin);
  url.port = gameId === "remake" ? "8765" : "8767";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}
