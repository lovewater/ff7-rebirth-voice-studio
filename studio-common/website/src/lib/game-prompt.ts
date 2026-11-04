import { gameProfile, type GameEnvironment } from "./game-profile";

type PromptMessage = { role: "system" | "user" | "assistant"; content: string };
const remakeContext = "当前游戏为《最终幻想VII 重制版》（Final Fantasy VII Remake），按本游戏的角色与剧情上下文处理。";

/** Change exact instruction-side branding; never rewrite dialogue or standalone 重生. */
export function gamePromptMessages(messages: PromptMessage[], env: GameEnvironment = process.env): PromptMessage[] {
  if (gameProfile(env).id === "rebirth") return messages;
  const result = messages.map(message => message.role !== "system" ? message : {
    ...message,
    content: message.content
      .replace(/最终幻想\s*(?:VII|7)\s*[：:]?\s*重生/g, "最终幻想VII 重制版")
      .replace(/\bFinal\s+Fantasy\s+VII\s+Rebirth\b/gi, "Final Fantasy VII Remake")
      .replace(/\bFF7\s+Rebirth\b/gi, "FF7 Remake"),
  });
  const firstSystem = result.findIndex(message => message.role === "system");
  if (firstSystem < 0) result.unshift({ role: "system", content: remakeContext });
  else if (!result[firstSystem].content.startsWith(remakeContext)) {
    result[firstSystem] = { ...result[firstSystem], content: `${remakeContext}\n${result[firstSystem].content}` };
  }
  return result;
}
