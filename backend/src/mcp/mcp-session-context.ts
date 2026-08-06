import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The MCP session id of the tool call currently executing, made ambient by the
 * per-call wrapper in `mcp-relay-tool-activity.ts` so code deep inside a tool
 * handler can tell WHICH client is calling without threading the id through
 * every helper signature.
 *
 * This exists because "which session is this" is a correctness question, not a
 * diagnostic one: a reverse-relay turn belongs to the one session that claimed
 * the prompt, and a write arriving from any other session of the same user is a
 * direct MCP client's -- its confirmation belongs in that client, not in the
 * web chat. Keyed on userId alone, one abandoned web-chat turn captured every
 * direct write the user made afterwards.
 *
 * Absent means "cannot prove which session" -- callers must treat that as a
 * direct client (confirm locally), never as a relay turn.
 */
const sessionStorage = new AsyncLocalStorage<{ sessionId?: string }>();

export function withMcpSession<T>(
  sessionId: string | undefined,
  fn: () => T,
): T {
  return sessionStorage.run({ sessionId }, fn);
}

export function currentMcpSessionId(): string | undefined {
  return sessionStorage.getStore()?.sessionId;
}
