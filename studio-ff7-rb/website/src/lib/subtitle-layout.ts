// Subtitle wrapping follows the original subtitle, independently of TTS text.
export const SUBTITLE_LAYOUT = "source-lines";

export function subtitleLineCount(text: string): number {
  return text.replace(/\\n/g, "\n").split(/\n+/).filter((line) => line.trim()).length;
}

export function subtitleLayout(text: string, original: string): string {
  if (subtitleLineCount(text) !== subtitleLineCount(original)) {
    throw new Error("候选字幕行数与原字幕不同");
  }
  return text;
}
