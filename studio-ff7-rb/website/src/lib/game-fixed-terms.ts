import { sql } from "./db";
import { currentLlmStem } from "./llm-metrics";
import { currentChineseTexts, gameTermInstruction, matchedGameTerms } from "./game-term-matching";
import type { ChatMessage } from "./llm-chat-client";

const writingTasks=new Set(["script-rewrite","manual-rewrite","fallback-duration-rewrite","two-parts-repair","three-parts-repair","prompt-trial-script-rewrite","accepted-script-polish"]);
/** 放在最终创作HTTP入口，模板解析后追加，覆盖自动各轮、手动、降级及直接调用的润色。
 * 每次读库，不缓存跨句结果；只保护本句原中文/当前稿命中词，不影响ASR校字或分类。
 */
export async function withGameFixedTerms(messages: ChatMessage[], task: string, stem?: string): Promise<ChatMessage[]> {
  if(!writingTasks.has(task))return messages;
  const currentStem=stem??currentLlmStem();
  const texts=currentChineseTexts(messages);
  if(currentStem){const [row]=await sql<{text_zh:string|null}[]>`SELECT text_zh FROM lines WHERE stem=${currentStem}`;if(row?.text_zh)texts.unshift(row.text_zh);}
  if(!texts.length)return messages;
  const rows=await sql<{term:string}[]>`SELECT term FROM game_fixed_terms ORDER BY char_length(term) DESC,term`;
  const hits=matchedGameTerms(texts,rows.map(row=>row.term));
  return hits.length?[...messages,{role:"user",content:gameTermInstruction(hits)}]:messages;
}
