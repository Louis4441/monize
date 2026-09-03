import { z } from "zod";
import {
  createMcpHandler,
  InMemoryTransport,
  McpServer,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { resolveUserContext, toAuthInfo, toolResult } from "./mcp-context";
import { callerKey } from "./mcp-context";

/**
 * One server definition, two protocol eras, in process.
 *
 * The transport serves 2026-07-28 through `createMcpHandler` and 2025-era
 * traffic through the sessionful path, from the SAME factory. What that buys is
 * only worth anything if both eras really reach the same tools with the same
 * identity, and neither a unit test of a handler nor a mocked transport can
 * show it -- so this drives the real SDK on both wires and asserts the answers
 * agree.
 */

const AUTH = toAuthInfo(
  { userId: "u1", scopes: "read,write", credentialId: "pat:t1" },
  "tok",
) as AuthInfo;

/** The definition under test: one read tool that reports who is calling. */
function buildServer(): McpServer {
  const server = new McpServer(
    { name: "monize", version: "9.9.9" },
    {
      instructions: "Monize test server.",
      capabilities: { tools: {}, resources: {}, prompts: {} },
    },
  );
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "The caller this request resolved to.",
      inputSchema: z.object({}),
    },
    (_args, ctx) => {
      const user = resolveUserContext(ctx);
      return toolResult({
        userId: user?.userId ?? null,
        callerKey: callerKey(ctx) ?? null,
      });
    },
  );
  return server;
}

describe("MCP protocol eras", () => {
  describe("a 2026-07-28 client", () => {
    let handler: ReturnType<typeof createMcpHandler>;
    let client: Client;

    beforeEach(async () => {
      handler = createMcpHandler(() => buildServer(), { legacy: "reject" });
      client = new Client(
        { name: "test-client", version: "0.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      // The transport never dials the URL: handler.fetch serves every request
      // in process, with the authInfo the Nest controller would have attached.
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
          fetch: (url: string | URL | Request, init?: RequestInit) =>
            handler.fetch(new Request(url as never, init), { authInfo: AUTH }),
        }),
      );
    });

    afterEach(async () => {
      await client.close();
      await handler.close();
    });

    it("negotiates the modern era", () => {
      expect(client.getProtocolEra()).toBe("modern");
    });

    it("serves the same tool, resolving the caller from the request", async () => {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(["whoami"]);

      const result = await client.callTool({ name: "whoami", arguments: {} });
      // No session exists on this era, so the caller key is the credential.
      expect(result.structuredContent).toEqual({
        userId: "u1",
        callerKey: "pat:t1",
      });
    });
  });

  describe("a 2025-era client", () => {
    let server: McpServer;
    let client: Client;

    beforeEach(async () => {
      server = buildServer();
      client = new Client({ name: "test-client", version: "0.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      // The sessionful transport attaches the validated AuthInfo to every
      // inbound message, exactly as the Nest controller does through req.auth.
      const send = clientTransport.send.bind(clientTransport);
      clientTransport.send = (message, options) =>
        send(message, { ...options, authInfo: AUTH });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    });

    afterEach(async () => {
      await client.close();
    });

    it("negotiates the legacy era", () => {
      expect(client.getProtocolEra()).toBe("legacy");
    });

    it("serves the same tool, resolving the same caller", async () => {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(["whoami"]);

      const result = await client.callTool({ name: "whoami", arguments: {} });
      expect((result.structuredContent as { userId: string }).userId).toBe(
        "u1",
      );
    });
  });
});
