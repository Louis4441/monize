import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import {
  clientAnsweredForItself,
  elicitationBehaviour,
  recordElicitationAnswered,
  recordElicitationSilent,
} from "./mcp-elicitation-support";

export type WriteConfirmation = "accepted" | "declined" | "unsupported";

/**
 * How long the confirmation dialog may stay unanswered.
 *
 * A human needs time to read and decide, so this overrides the SDK's short
 * default request timeout -- but it must still expire BEFORE the client gives
 * up on the `tools/call` that is waiting for it. Claude's MCP tool deadline is
 * 60s, and the previous five-minute wait meant a client that never answers the
 * elicitation produced no result at all: the tool call died at the client's own
 * deadline with an opaque "timed out after 60s", no write and no explanation.
 * Staying under the client deadline is what makes every branch below reportable.
 *
 * It bounds a 2025-era dialog only. A 2026-07-28 request has no server-side
 * wait at all -- the server returns and the client calls the tool again -- so
 * the human's window there is the request state's own TTL.
 */
export const CONFIRM_TIMEOUT_MS = 45 * 1000;

/**
 * Ask the MCP client to confirm a write -- the MCP-native equivalent of the AI
 * Assistant's approve/reject card. Returns:
 *  - "accepted": the user approved; proceed with the write.
 *  - "declined": the user answered and the answer was no (reject/cancel), or
 *    the dialog failed in a way we cannot account for; abort, so a write never
 *    happens over a user's refusal.
 *  - "unsupported": no dialog reached a human, so the caller falls back to its
 *    normal behavior. The client still gates every tool call with its own
 *    approval prompt, so this is not a consent bypass -- it is the only consent
 *    step such a client has.
 *
 * **The advertised capability is not evidence that a dialog can be shown.**
 * The SDK normalizes the legacy 2025-06-18 shape `{"elicitation":{}}` into
 * `{"elicitation":{"form":{}}}` before `getClientCapabilities()` ever sees it,
 * so `elicitation.form` is truthy for every client that advertises elicitation
 * at all -- including the ones that answer -32601 to `elicitation/create`, and
 * the ones that never answer it. That was the whole regression: those clients
 * looked form-capable, so a failure to answer was read as the user saying no
 * and every write through Claude was refused or hung until the client's own
 * deadline. `mcp-confirm.spec.ts` pins the SDK's normalization so this cannot
 * silently flip back into a load-bearing check.
 *
 * So the *outcome* carries the weight, not the capability: only a returned
 * `action` is a user's answer. The pre-check is kept because a client
 * advertising no elicitation at all still deserves to skip the round trip.
 *
 * The elicitation goes out through `ctx.mcpReq.elicitInput`, which relates it
 * to the in-flight tool call. A server-to-client request with no related
 * request id is routed to the standalone GET SSE stream, which a tool-calling
 * client (Claude Desktop, IDE agents) does not keep open during a `tools/call`
 * -- so it would be silently dropped and never shown. The request-bound
 * accessor is what sends it back over that call's own POST SSE stream, where
 * the client is listening.
 *
 * `server` is the session's `McpServer`, which every tool's `register` closure
 * already holds. It carries the client's advertised capabilities and keys the
 * per-session record of what that client actually does with a dialog.
 */
export async function confirmWrite(
  server: McpServer,
  ctx: ServerContext,
  message: string,
): Promise<WriteConfirmation> {
  const capabilities = server.server.getClientCapabilities();
  if (!capabilities?.elicitation?.form) {
    return "unsupported";
  }
  // A client already caught answering for itself is not asked again: on a
  // client that drops the request, the round trip costs CONFIRM_TIMEOUT_MS
  // every time, which on a 25-row individual batch is the same paralysis in
  // slow motion.
  if (elicitationBehaviour(server) === "silent") {
    return "unsupported";
  }
  try {
    const result = await ctx.mcpReq.elicitInput(
      {
        message,
        // No fields to collect -- the accept/decline/cancel action is the answer.
        requestedSchema: { type: "object", properties: {} },
      },
      { timeout: CONFIRM_TIMEOUT_MS },
    );
    recordElicitationAnswered(server);
    return result.action === "accept" ? "accepted" : "declined";
  } catch (err) {
    if (!clientAnsweredForItself(err)) {
      return "declined";
    }
    // A client that has already shown a dialog in this session can show
    // another, so this failure is one unanswered dialog, not a client with no
    // human behind it -- refuse rather than fall through to the write.
    if (elicitationBehaviour(server) === "answers") {
      return "declined";
    }
    recordElicitationSilent(server);
    return "unsupported";
  }
}
