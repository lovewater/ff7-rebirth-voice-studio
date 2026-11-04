import { createHash } from "node:crypto";

export type AsrWordRule = { id: number; word: string; aliases: string[]; enabled: boolean; note: string | null };
export type AsrWordHit = { ruleId: number; word: string; alias: string; scriptStart: number; asrStart: number; asrEnd: number };
export type AsrWordCorrection = {
  version: "asr-word-corrections-v1"; script: string; rawText: string; correctedText: string;
  scriptSha256: string; rawSha256: string; rulesSha256: string; hits: AsrWordHit[];
  reason: "matched" | "none" | "ambiguous" | "size-limit";
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const asrComparisonBody = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "");

/** Only compare ASR against names actually in this intended script. Raw ASR and
 * all word timestamps remain unchanged. Insertions/deletions cost real edits;
 * configured alias edges cannot swallow missing, repeated or unrelated words.
 * Among equally good edit alignments prefer fewer corrections. If two optimal
 * paths still disagree about any corrected occurrence, leave the whole text raw.
 */
export function correctAsrWords(script: string, rawText: string, rules: AsrWordRule[]): AsrWordCorrection {
  const active = rules.filter(r => r.enabled && r.word && r.aliases.length)
    .map(r => ({ ...r, aliases: [...new Set(r.aliases)].sort() })).sort((a,b) => a.id-b.id);
  const base: AsrWordCorrection = { version: "asr-word-corrections-v1", script, rawText, correctedText: rawText,
    scriptSha256: hash(script), rawSha256: hash(rawText), rulesSha256: hash(JSON.stringify(active)), hits: [], reason: "none" };
  const expected = Array.from(asrComparisonBody(script));
  const actual: string[] = [], offsets: number[] = [];
  let offset = 0;
  for (const c of rawText) { if (asrComparisonBody(c)) { actual.push(c); offsets.push(offset); } offset += c.length; }
  const candidates = active.flatMap(r => r.aliases.filter(a => a !== r.word && asrComparisonBody(rawText).includes(a))
    .map(alias => ({ rule: r, word: Array.from(r.word), alias: Array.from(alias), aliasText: alias })))
    .filter(r => asrComparisonBody(script).includes(r.rule.word));
  if (!expected.length || !actual.length || !candidates.length) return base;
  const width = actual.length + 1, cells = (expected.length + 1) * width;
  if (cells > 1_500_000) return { ...base, reason: "size-limit" };
  // Edit cost dominates the total possible alias count. A signature represents
  // the exact correction occurrences, so harmless ambiguity in other edits is OK.
  const weight = expected.length + actual.length + 1;
  const score = new Int32Array(cells).fill(0x3fffffff), signatures = new Int32Array(cells).fill(-1);
  score[0] = 0; signatures[0] = 0;
  const chains: { previous: number; hit: AsrWordHit }[] = [];
  const intern = new Map<string, number>();
  const starts = (chars: string[], at: number, value: string[]) => value.every((c,k) => chars[at+k] === c);
  const append = (signature: number, hit: AsrWordHit) => {
    if (signature === -2) return -2;
    const key = JSON.stringify([signature, hit]); let id = intern.get(key);
    if (id === undefined) { chains.push({ previous: signature, hit }); id = chains.length; intern.set(key,id); }
    return id;
  };
  const visit = (from: number, to: number, cost: number, hit?: AsrWordHit) => {
    const next = score[from] + cost;
    if (next > score[to]) return;
    const signature = hit ? append(signatures[from], hit) : signatures[from];
    if (next < score[to]) { score[to] = next; signatures[to] = signature; }
    else if (signatures[to] !== signature) signatures[to] = -2;
  };
  for (let i=0;i<=expected.length;i++) for (let j=0;j<=actual.length;j++) {
    const at=i*width+j;
    if (signatures[at] === -1) continue;
    if (i<expected.length && j<actual.length) visit(at,at+width+1,expected[i]===actual[j]?0:weight);
    if (i<expected.length) visit(at,at+width,weight);
    if (j<actual.length) visit(at,at+1,weight);
    for (const c of candidates) if (i+c.word.length<=expected.length && j+c.alias.length<=actual.length
      && starts(expected,i,c.word) && starts(actual,j,c.alias)) {
      const end=j+c.alias.length-1;
      visit(at,(i+c.word.length)*width+j+c.alias.length,1,{ruleId:c.rule.id,word:c.rule.word,alias:c.aliasText,
        scriptStart:i,asrStart:offsets[j],asrEnd:offsets[end]+actual[end].length});
    }
  }
  let signature=signatures[cells-1];
  if (signature === -2) return { ...base, reason: "ambiguous" };
  const hits: AsrWordHit[]=[];
  while (signature>0) { const node=chains[signature-1]; hits.push(node.hit); signature=node.previous; }
  hits.reverse();
  if (!hits.length) return base;
  let correctedText=rawText;
  for (const h of [...hits].reverse()) correctedText=correctedText.slice(0,h.asrStart)+h.word+correctedText.slice(h.asrEnd);
  return { ...base, correctedText, hits, reason: "matched" };
}

/** The schema stores a group of aliases per canonical word, not TTS replacements. */
export function validateAsrWordRule(body: unknown) {
  if (!body || typeof body !== "object") throw new Error("词语配置格式无效");
  const row=body as Record<string,unknown>;
  const word=typeof row.word==='string'?row.word.trim():'';
  const valid=(s:string)=>s.length>0&&Array.from(s).length<=40&&asrComparisonBody(s)===s&&!/[\u0000-\u001f\u007f]/u.test(s);
  if(!valid(word))throw new Error("标准词须为1～40字，不能包含空白、标点或控制字符");
  if(!Array.isArray(row.aliases)||row.aliases.some(a=>typeof a!=='string'))throw new Error("识别别名必须是词语列表");
  const aliases=[...new Set((row.aliases as string[]).map(a=>a.trim()).filter(Boolean))];
  if(!aliases.length||aliases.length>64||aliases.some(a=>!valid(a)||a===word))throw new Error("须填写1～64个识别别名，每个1～40字，且不能等于标准词");
  if(row.enabled!==undefined&&typeof row.enabled!=='boolean')throw new Error("启用状态无效");
  if(row.note!==undefined&&row.note!==null&&typeof row.note!=='string')throw new Error("备注格式无效");
  const note=typeof row.note==='string'?row.note.trim():'';
  if(note.length>500)throw new Error("备注最长500字");
  return {word,aliases,enabled:row.enabled!==false,note:note||null};
}
