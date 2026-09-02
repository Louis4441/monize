import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

/**
 * What this session's client has actually been observed to do with an
 * `elicitation/create` request.
 *
 * The advertised capability cannot answer this. `@modelcontextprotocol/sdk`
 * >= 1.23 rewrites the legacy 2025-06-18 shape `{"elicitation":{}}` into
 * `{"elicitation":{"form":{}}}` before `getClientCapabilities()` sees it
 * (`ElicitationCapabilitySchema`'s `z.preprocess`), so every client that
 * advertises elicitation at all now looks form-capable -- the ones that answer
 * -32601, and the ones that never answer, included. Only behaviour separates
 * them, so behaviour is what we record.
 *
 *  - "unknown":  nothing observed yet.
 *  - "answers":  the client returned an accept/decline/cancel at least once, so
 *                it demonstrably shows dialogs to a human.
 *  - "silent":   the client answered for itself (rejected the method, dropped
 *                the connection, or never replied), so no human is behind it.
 */
export type ElicitationBehaviour = "unknown" | "answers" | "silent";

/**
 * Keyed on the `McpServer` because there is exactly one per MCP session
 * (`mcp-http.controller.ts` builds a fresh server per `Mcp-Session-Id`), and a
 * weak key means the record dies with the session -- no cleanup hook to forget,
 * and no way for one client's observed behaviour to be read for another's.
 */
const observed = new WeakMap<McpServer, ElicitationBehaviour>();

export function elicitationBehaviour(server: McpServer): ElicitationBehaviour {
  return observed.get(server) ?? "unknown";
}

export function recordElicitationAnswered(server: McpServer): void {
  observed.set(server, "answers");
}

/**
 * Record that the client answered for itself. A client that has already proven
 * it shows dialogs is NOT demoted: a single dropped connection or unanswered
 * dialog on a capable client is a one-off, not evidence that the next
 * confirmation would go unseen.
 */
export function recordElicitationSilent(server: McpServer): void {
  if (observed.get(server) !== "answers") {
    observed.set(server, "silent");
  }
}

/**
 * Whether an `elicitInput` rejection means the client answered for itself
 * rather than for its user: it rejected the request as unknown or malformed,
 * the connection went away, or it never replied at all. `MethodNotFound` is the
 * one that matters in practice -- a client that advertises `elicitation` and
 * then answers -32601 to `elicitation/create`.
 *
 * An unknown rejection shape is deliberately absent, so a failure nobody has
 * reasoned about refuses the write instead of waving it through.
 */
export function clientAnsweredForItself(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return (
    typeof code === "number" &&
    (code === ErrorCode.ConnectionClosed ||
      code === ErrorCode.RequestTimeout ||
      code === ErrorCode.ParseError ||
      code === ErrorCode.InvalidRequest ||
      code === ErrorCode.MethodNotFound ||
      code === ErrorCode.InvalidParams)
  );
}
