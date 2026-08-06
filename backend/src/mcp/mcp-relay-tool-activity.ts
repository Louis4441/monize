import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UserContextResolver } from "./mcp-context";
import type { AiRelayService } from "../ai/relay/ai-relay.service";
import { withMcpSession } from "./mcp-session-context";

// Relay control tools are infrastructure (the long-poll and answer channel),
// not work the user should see as progress.
export const RELAY_CONTROL_TOOLS = new Set([
  "get_next_prompt",
  "post_response",
  "report_progress",
]);

type ToolHandler = (
  args: unknown,
  extra: { sessionId?: string },
) => unknown | Promise<unknown>;

/**
 * Wrap a tool handler so that, when the call is serving a relayed browser
 * prompt, it streams `tool_start` before and `tool_result` after to the web
 * chat. The agent (Claude CLI/Desktop) does not reliably narrate progress via
 * report_progress, but it always invokes the actual data tools -- and those
 * calls reach us -- so surfacing them gives the web chat live "Looking up ..."
 * progress automatically. Outside relay context `reportToolActivity` finds no
 * in-flight prompt and is a no-op.
 */
export function wrapToolHandlerForRelay(
  name: string,
  handler: ToolHandler,
  resolve: UserContextResolver,
  relayService: AiRelayService,
): ToolHandler {
  return async (args, extra) => {
    const sessionId = extra?.sessionId;
    const userId = resolve(sessionId)?.userId;
    // Every tool handler runs inside its session's ambient context, so a write
    // deep inside one can tell whether it is serving this session's relay turn
    // or is a direct MCP client's own call (see mcp-session-context.ts).
    return withMcpSession(sessionId, async () => {
      if (userId) {
        relayService.reportToolActivity(
          userId,
          name,
          "start",
          false,
          sessionId,
        );
      }
      let isError = false;
      try {
        const result = await handler(args, extra);
        isError = Boolean(
          (result as { isError?: boolean } | undefined)?.isError,
        );
        return result;
      } catch (err) {
        isError = true;
        throw err;
      } finally {
        if (userId) {
          relayService.reportToolActivity(
            userId,
            name,
            "result",
            isError,
            sessionId,
          );
        }
      }
    });
  };
}

/**
 * Monkeypatch `server.registerTool` so every tool registered afterwards is
 * wrapped with `wrapToolHandlerForRelay` (relay control tools excepted). Must
 * run before the tool providers register their tools.
 */
export function installRelayToolActivity(
  server: McpServer,
  resolve: UserContextResolver,
  relayService: AiRelayService,
): void {
  const baseRegister = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    handler: ToolHandler,
  ) => unknown;

  (server as { registerTool: unknown }).registerTool = (
    name: string,
    config: unknown,
    handler: ToolHandler,
  ) => {
    if (RELAY_CONTROL_TOOLS.has(name)) {
      return baseRegister(name, config, handler);
    }
    return baseRegister(
      name,
      config,
      wrapToolHandlerForRelay(name, handler, resolve, relayService),
    );
  };
}
