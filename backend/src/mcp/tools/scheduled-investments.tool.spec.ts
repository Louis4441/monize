import { McpScheduledInvestmentsTool } from "./scheduled-investments.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpScheduledInvestmentsTool", () => {
  let tool: McpScheduledInvestmentsTool;
  let svc: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    svc = { getLlmUpcoming: jest.fn() };
    tool = new McpScheduledInvestmentsTool(svc as any);
    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };
    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("registers a single tool", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    expect(server.registerTool).toHaveBeenCalledWith(
      "get_scheduled_investments",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns error when no user context", async () => {
    resolve.mockReturnValue(undefined);
    const r = await handlers["get_scheduled_investments"](
      {},
      { sessionId: "s1" },
    );
    expect(r.isError).toBe(true);
  });

  it("calls service.getLlmUpcoming with default days", async () => {
    resolve.mockReturnValue({ userId: "u1", scopes: "read" });
    svc.getLlmUpcoming.mockResolvedValue([{ id: "si-1", name: "VOO DCA" }]);
    const r = await handlers["get_scheduled_investments"](
      {},
      { sessionId: "s1" },
    );
    expect(svc.getLlmUpcoming).toHaveBeenCalledWith("u1", 30);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed[0].name).toBe("VOO DCA");
  });

  it("respects explicit days argument", async () => {
    resolve.mockReturnValue({ userId: "u1", scopes: "read" });
    svc.getLlmUpcoming.mockResolvedValue([]);
    await handlers["get_scheduled_investments"](
      { days: 7 },
      { sessionId: "s1" },
    );
    expect(svc.getLlmUpcoming).toHaveBeenCalledWith("u1", 7);
  });
});
