import path from "node:path";
import { englishAudioRelativePath } from "./source-audio-policy";

export function sourceAudioFile(dataRoot: string, stem: string, language: "jp" | "cn" | "en", extra: unknown, requireEnglishPairing = false): string | null {
  const relative = language === "en" ? englishAudioRelativePath(stem, extra, requireEnglishPairing)
    : /^[\w.\-]+$/.test(stem) ? `${language}/${stem}.mp3` : null;
  if (!relative) return null;
  const root = path.resolve(dataRoot, language);
  const file = path.resolve(dataRoot, relative);
  return file.startsWith(`${root}${path.sep}`) ? file : null;
}
