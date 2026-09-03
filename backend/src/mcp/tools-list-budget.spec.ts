import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { collectToolConfigs } from "./testing/collect-tool-configs";
import { McpServerService } from "./mcp-server.service";

/**
 * Every byte of `tools/list` rides in the model's context on EVERY request, and
 * the server instructions ride beside it. Nothing measured that, so the payload
 * grew to ~11,600 tokens for 20 tools: each defect fix appended a paragraph, the
 * same fact was stated in the tool description AND the field description AND the
 * instructions, and enum members were spelled out in prose beside the `z.enum`
 * that already carries them.
 *
 * This spec serializes the real `tools/list` through the SDK (the same
 * JSON-Schema conversion a client receives) and fails when a tool, the total, or
 * the instructions exceed their budget. Raising a cap is a reviewed decision,
 * not a fix for a failing build.
 */

// Bytes of serialized JSON per tool in the `tools/list` result, pinned to the
// measured size. A cap is a ratchet: lower it when a tool shrinks, and raise one
// only as a reviewed decision.
const TOOL_BYTE_BUDGET: Record<string, number> = {
  list_accounts: 4192,
  list_transactions: 4832,
  compare_periods: 2600,
  manage_transactions: 9671,
  list_categories: 1477,
  list_payees: 1604,
  manage_payees: 4753,
  generate_report: 5271,
  get_portfolio_summary: 6639,
  list_investment_transactions: 4226,
  list_capital_gains: 3123,
  lookup_securities: 2185,
  manage_securities: 5759,
  manage_investment_transactions: 6686,
  list_upcoming_bills: 4556,
  calculate: 1365,
  get_budget_status: 3255,
  get_next_prompt: 2557,
  post_response: 1411,
  report_progress: 2045,
};

const TOTAL_BYTE_BUDGET = 78_300;
const INSTRUCTIONS_BYTE_BUDGET = 8_800;

/**
 * The order the SDK lists tools in, which follows the registration order in
 * `mcp-server.service.ts`. MCP revision 2026-07-28 asks servers to return
 * `tools/list` in a deterministic order; this pins ours so a reordered
 * registration is a visible decision (clients cache the list).
 */
const EXPECTED_TOOL_ORDER = [
  "list_accounts",
  "list_transactions",
  "compare_periods",
  "manage_transactions",
  "list_categories",
  "list_payees",
  "manage_payees",
  "generate_report",
  "get_portfolio_summary",
  "list_investment_transactions",
  "list_capital_gains",
  "lookup_securities",
  "manage_securities",
  "manage_investment_transactions",
  "list_upcoming_bills",
  "calculate",
  "get_budget_status",
  "get_next_prompt",
  "post_response",
  "report_progress",
];

/**
 * Phrases that describe the codebase's history or another surface rather than
 * telling the model how to use the tool. Each one is paid for on every request.
 */
const BANNED_DESCRIPTION_PHRASES: Array<{ phrase: string; why: string }> = [
  {
    phrase: "Returns the same shape as the AI Assistant",
    why: "an MCP client cannot see the AI Assistant's tools",
  },
  {
    phrase: "Shares the lookup logic with the AI Assistant",
    why: "an MCP client cannot see the AI Assistant's tools",
  },
  {
    phrase: "replaces the former",
    why: "renamed-tool history guides nobody",
  },
  {
    phrase: "This single tool replaces",
    why: "renamed-tool history guides nobody",
  },
];

interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

async function listRealTools(): Promise<{
  tools: ListedTool[];
  bytesByTool: Map<string, number>;
}> {
  const server = new McpServer(
    { name: "monize-budget", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  for (const { name, config } of collectToolConfigs()) {
    server.registerTool(name, config, () => ({
      content: [{ type: "text" as const, text: "{}" }],
      structuredContent: {},
    }));
  }

  const client = new Client(
    { name: "budget-client", version: "0.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const listed = await client.listTools();
    const bytesByTool = new Map<string, number>();
    for (const tool of listed.tools) {
      bytesByTool.set(tool.name, JSON.stringify(tool).length);
    }
    return { tools: listed.tools as ListedTool[], bytesByTool };
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * Bytes per token for this payload, calibrated against a real tokenizer: the
 * 78,207-byte baseline measured here was reported as 11,602 tokens, so the
 * naive bytes/4 rule overstates it by two thirds. JSON with repeated keys and
 * structure tokenizes far better than prose.
 */
const BYTES_PER_TOKEN = 6.7;

/** A table of every tool's size, so the numbers are visible in the failure. */
function sizeTable(bytesByTool: Map<string, number>): string {
  const rows = [...bytesByTool.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((sum, [, bytes]) => sum + bytes, 0);
  const lines = rows.map(([name, bytes]) => {
    const budget = TOOL_BYTE_BUDGET[name];
    const flag = budget !== undefined && bytes > budget ? "  OVER" : "";
    return `  ${name.padEnd(32)} ${String(bytes).padStart(6)} bytes  ~${String(
      Math.round(bytes / BYTES_PER_TOKEN),
    ).padStart(5)} tokens (budget ${budget ?? "unset"})${flag}`;
  });
  lines.push(
    `  ${"TOTAL".padEnd(32)} ${String(total).padStart(6)} bytes  ~${String(
      Math.round(total / BYTES_PER_TOKEN),
    ).padStart(5)} tokens (budget ${TOTAL_BYTE_BUDGET})`,
  );
  return `\ntools/list payload:\n${lines.join("\n")}\n`;
}

/** Every enum in a serialized JSON Schema, keyed by the property that holds it. */
function enumsByProperty(schema: unknown): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (node: unknown, propertyName: string | null) => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.enum) && propertyName) {
      const members = obj.enum.filter(
        (v): v is string => typeof v === "string",
      );
      if (members.length >= 3) found.set(propertyName, members);
    }
    if (obj.properties && typeof obj.properties === "object") {
      for (const [key, value] of Object.entries(
        obj.properties as Record<string, unknown>,
      )) {
        walk(value, key);
      }
    }
    if (obj.items) walk(obj.items, propertyName);
  };
  walk(schema, null);
  return found;
}

/** Every `description` in a serialized JSON Schema, keyed by its property. */
function describesByProperty(schema: unknown): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (node: unknown, propertyName: string | null) => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.description === "string" && propertyName) {
      found.set(propertyName, obj.description);
    }
    if (obj.properties && typeof obj.properties === "object") {
      for (const [key, value] of Object.entries(
        obj.properties as Record<string, unknown>,
      )) {
        walk(value, key);
      }
    }
    if (obj.items) walk(obj.items, propertyName);
  };
  walk(schema, null);
  return found;
}

describe("tools/list payload budget", () => {
  let tools: ListedTool[];
  let bytesByTool: Map<string, number>;

  beforeAll(async () => {
    ({ tools, bytesByTool } = await listRealTools());
  });

  it("keeps every tool within its byte budget", () => {
    const report = sizeTable(bytesByTool);
    const over = [...bytesByTool.entries()]
      .filter(([name, bytes]) => {
        const budget = TOOL_BYTE_BUDGET[name];
        return budget === undefined || bytes > budget;
      })
      .map(
        ([name, bytes]) =>
          `${name}: ${bytes} bytes exceeds budget ${TOOL_BYTE_BUDGET[name] ?? "(unset)"}`,
      );

    // Compared against the report itself so a failure prints the whole table.
    expect(
      over.length === 0
        ? report
        : `${report}\nOVER BUDGET:\n${over.join("\n")}`,
    ).toBe(report);
  });

  it("keeps the whole payload within the total budget", () => {
    const report = sizeTable(bytesByTool);
    const total = [...bytesByTool.values()].reduce((a, b) => a + b, 0);
    const verdict =
      total <= TOTAL_BYTE_BUDGET
        ? report
        : `${report}\nTOTAL ${total} exceeds budget ${TOTAL_BYTE_BUDGET}`;
    expect(verdict).toBe(report);
  });

  it("keeps the server instructions within budget", () => {
    // The instructions are built independently of tool registration, so empty
    // provider doubles are enough to read them back off the server.
    const noopProvider = { register: () => {} } as any;
    const service = new McpServerService(
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      {} as any,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
    );
    const server = service.createServer(() => undefined);
    const instructions = (server.server as any)._instructions as string;

    expect(typeof instructions).toBe("string");
    const verdict =
      instructions.length <= INSTRUCTIONS_BYTE_BUDGET
        ? "within budget"
        : `instructions are ${instructions.length} bytes (~${Math.round(instructions.length / BYTES_PER_TOKEN)} tokens), budget ${INSTRUCTIONS_BYTE_BUDGET}`;
    expect(verdict).toBe("within budget");
  });

  it("lists tools in a deterministic, pinned order", () => {
    expect(tools.map((t) => t.name)).toEqual(EXPECTED_TOOL_ORDER);
  });
});
