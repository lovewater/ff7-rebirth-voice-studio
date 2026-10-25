export type Pronunciation = { id: number; src: string; dst: string; note: string | null };

const PAUSE_TOKEN = /(\[停顿=\d{1,4}\]|\p{Script=Han}\[[A-Za-z]+[0-9]+\])/gu;

export function applyPronunciations(text: string, rules: Pronunciation[]): string {
  const sorted = [...rules]
    .filter((r) => r.src)
    .sort((a, b) => b.src.length - a.src.length || a.src.localeCompare(b.src));
  return text.split(PAUSE_TOKEN).map((part) => {
    if (/^(?:\[停顿=\d{1,4}\]|\p{Script=Han}\[[A-Za-z]+[0-9]+\])$/u.test(part)) return part;
    let out = part;
    for (const rule of sorted) {
      out = out.split(rule.src).join(rule.dst);
    }
    return out;
  }).join("");
}
