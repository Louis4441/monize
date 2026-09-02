import { sanitizeToolResultStrings } from "../common/sanitization.util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import {
  clientAnsweredForItself,
  elicitationBehaviour,
  recordElicitationAnswered,
  recordElicitationSilent,
} from "./mcp-elicitation-support";

export interface McpUserContext {
  userId: string;
  scopes: string;
  /**
   * Stable identifier of the credential that authorized this request: the PAT
   * row's id, or the OAuth grant behind the access token.
   *
   * A session is bound to one credential. Matching only `userId` let a session
   * outlive the credential that created it: a read-only PAT presenting the
   * session id of a session opened with a write PAT inherited the write scope,
   * and a replacement token kept a session alive after the original was revoked
   * (P2-004). Absent only for a context built before this field existed, which
   * the transport treats as "cannot be matched" and refuses.
   */
  credentialId?: string;
}

export type UserContextResolver = (
  sessionId?: string,
) => McpUserContext | undefined;

export function hasScope(scopes: string, required: string): boolean {
  return scopes.split(",").includes(required);
}

export function requireScope(
  scopes: string,
  required: string,
):
  | {
      error: true;
      result: { content: { type: "text"; text: string }[]; isError: true };
    }
  | { error: false } {
  if (!hasScope(scopes, required)) {
    return {
      error: true,
      result: {
        content: [
          {
            type: "text",
            text: `Error: Insufficient scope. Requires "${required}" scope.`,
          },
        ],
        isError: true,
      },
    };
  }
  return { error: false };
}

export function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

/**
 * Converts an unknown error into a safe tool error response.
 * Known HTTP exceptions (4xx) pass through their message;
 * all other errors return a generic message to avoid leaking internals.
 */
export function safeToolError(err: unknown) {
  if (
    err &&
    typeof err === "object" &&
    "getStatus" in err &&
    typeof (err as any).getStatus === "function"
  ) {
    const status = (err as any).getStatus();
    if (status >= 400 && status < 500) {
      const response = (err as any).getResponse?.();
      const message =
        typeof response === "string"
          ? response
          : (response?.message ?? "Request failed");
      return toolError(
        typeof message === "string" ? message : "Request failed",
      );
    }
  }
  return toolError("An error occurred while processing your request");
}

/**
 * Wrap a sanitized payload into the object form required for an MCP tool's
 * `structuredContent`. Bare arrays are nested under `items` (structured content
 * must be a JSON object); primitives under `value`; objects pass through.
 */
function toStructuredContent(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) {
    return { items: data };
  }
  if (data !== null && typeof data === "object") {
    return data as Record<string, unknown>;
  }
  return { value: data };
}

/**
 * Recursively replace non-finite numbers (NaN, Infinity, -Infinity) with null.
 *
 * Structured-output validation runs against this in-memory object, and each
 * tool's outputSchema is also serialized to JSON Schema for `tools/list`.
 * Neither can represent NaN -- a `z.nan()` branch throws "NaN cannot be
 * represented in JSON Schema" and fails the entire tools/list response, so
 * clients see zero tools. null is exactly what JSON.stringify already emits for
 * these values on the wire, so the normalization is lossless.
 */
function normalizeNonFiniteNumbers(data: unknown): unknown {
  if (typeof data === "number") {
    return Number.isFinite(data) ? data : null;
  }
  if (Array.isArray(data)) {
    return data.map((item) => normalizeNonFiniteNumbers(item));
  }
  if (data !== null && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = normalizeNonFiniteNumbers(value);
    }
    return result;
  }
  return data;
}

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
 */
const CONFIRM_TIMEOUT_MS = 45 * 1000;

/**
 * Ask the MCP client to confirm a write via elicitation -- the MCP-native
 * equivalent of the AI Assistant's approve/reject card. Returns:
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
 * `@modelcontextprotocol/sdk` >= 1.23 normalizes the legacy 2025-06-18 shape
 * `{"elicitation":{}}` into `{"elicitation":{"form":{}}}` before
 * `getClientCapabilities()` ever sees it (`ElicitationCapabilitySchema`'s
 * `z.preprocess`), so `elicitation.form` is now truthy for every client that
 * advertises elicitation at all -- including the ones that answer -32601 to
 * `elicitation/create`, and the ones that never answer it. That is the whole
 * regression: on SDK <= 1.22 those clients fell through to "unsupported" and
 * wrote under their own approval prompt; afterwards the same clients looked
 * form-capable, so a failure to answer was read as the user saying no and every
 * write through Claude was refused or hung until the client's own deadline.
 * `mcp-context.spec.ts` pins the SDK's normalization so this cannot silently
 * flip back into a load-bearing check.
 *
 * So the *outcome* carries the weight, not the capability: only a returned
 * `action` is a user's answer. The pre-check is kept because a client
 * advertising no elicitation at all still deserves to skip the round trip.
 *
 * `relatedRequestId` MUST be the in-flight tool call's request id (from the
 * handler's `extra.requestId`). Over the Streamable HTTP transport, a
 * server-to-client request with no related request id is routed to the
 * standalone GET SSE stream, which a tool-calling client (Claude Desktop, IDE
 * agents) does not keep open during a `tools/call` -- so the elicitation is
 * silently dropped and never shown. Threading the tool call's id sends the
 * elicitation back over that call's own POST SSE stream, where the client is
 * listening.
 */
export async function confirmWrite(
  server: McpServer,
  message: string,
  relatedRequestId: RequestId,
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
    const result = await server.server.elicitInput(
      {
        message,
        // No fields to collect -- the accept/decline/cancel action is the answer.
        requestedSchema: { type: "object", properties: {} },
      },
      { timeout: CONFIRM_TIMEOUT_MS, relatedRequestId },
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

export function toolResult(data: unknown) {
  const sanitized = normalizeNonFiniteNumbers(sanitizeToolResultStrings(data));
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(sanitized, null, 2) },
    ],
    structuredContent: toStructuredContent(sanitized),
  };
}
