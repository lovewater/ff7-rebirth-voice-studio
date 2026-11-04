import { AsyncLocalStorage } from "node:async_hooks";
import type { ChatModelId } from "./llm-chat-client";
const context = new AsyncLocalStorage<ChatModelId>();
/** 整轮工作流固定连接，并发句子互不影响；HTTP子请求须显式传递。 */
export function withChatModel<T>(model: ChatModelId, operation: () => T): T { return context.run(model, operation); }
export function currentChatModel() { return context.getStore(); }
