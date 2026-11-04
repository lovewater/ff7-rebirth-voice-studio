/** Keep select labels to the first visual line of a quote. */
export function firstLine(text: string | null | undefined): string {
  return String(text ?? "").split(/\r?\n/, 1)[0].replace(/\s+/g, " ").trim();
}
