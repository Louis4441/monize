import { McpPayeesTools } from "./payees.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpPayeesTools", () => {
  let tool: McpPayeesTools;
  let payeesService: Record<string, jest.Mock>;
  let prepService: Record<string, jest.Mock>;
  let server: {
    registerTool: jest.Mock;
    server: { getClientCapabilities: jest.Mock; elicitInput: jest.Mock };
  };
  let elicitInput: jest.Mock;
  let relayService: { emitPendingAction: jest.Mock };
  let actionBuilder: Record<string, jest.Mock>;
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    payeesService = {
      findAll: jest.fn(),
      search: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: "p2", name: "New Payee" }),
      update: jest.fn().mockResolvedValue({ id: "p2", name: "New Payee" }),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    prepService = {
      prepareCreatePayeeSingle: jest.fn().mockResolvedValue({
        name: "New Payee",
        defaultCategoryId: null,
        defaultCategoryName: null,
      }),
      prepareUpdatePayeeSingle: jest.fn().mockResolvedValue({
        payeeId: "p2",
        name: "New Payee",
        defaultCategoryId: null,
        defaultCategoryName: null,
      }),
      prepareDeletePayeeSingle: jest
        .fn()
        .mockResolvedValue({ payeeId: "p2", name: "Old Payee" }),
      prepareCreatePayees: jest.fn(),
      prepareUpdatePayees: jest.fn(),
      prepareDeletePayees: jest.fn(),
    };

    // Default: not serving a relayed prompt, so the tool uses its normal
    // (direct MCP-client) confirmation path.
    relayService = { emitPendingAction: jest.fn().mockReturnValue(false) };
    actionBuilder = {
      buildCreatePayee: jest.fn().mockReturnValue({ type: "create_payee" }),
      buildUpdatePayee: jest.fn().mockReturnValue({ type: "update_payee" }),
      buildDeletePayee: jest.fn().mockReturnValue({ type: "delete_payee" }),
      buildBatchActions: jest.fn().mockReturnValue({ type: "batch_actions" }),
    };

    tool = new McpPayeesTools(
      payeesService as any,
      prepService as any,
      relayService as any,
      actionBuilder as any,
    );

    elicitInput = jest.fn().mockResolvedValue({ action: "accept" });
    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
      // Default to no elicitation capability so writes proceed (matches a client
      // that can't show a dialog); the decline test overrides these.
      server: {
        getClientCapabilities: jest.fn().mockReturnValue({}),
        elicitInput,
      },
    };

    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("should register 2 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(2);
  });

  describe("get_payees", () => {
    it("should return all payees without search", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      payeesService.findAll.mockResolvedValue([{ id: "p1", name: "Amazon" }]);

      const result = await handlers["get_payees"]({}, { sessionId: "s1" });
      expect(payeesService.findAll).toHaveBeenCalledWith("u1");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed[0].name).toBe("Amazon");
    });

    it("should search payees when query provided", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      payeesService.search.mockResolvedValue([{ id: "p1", name: "Amazon" }]);

      await handlers["get_payees"]({ search: "ama" }, { sessionId: "s1" });
      expect(payeesService.search).toHaveBeenCalledWith("u1", "ama", 50);
    });

    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["get_payees"]({}, { sessionId: "s1" });
      expect(result.isError).toBe(true);
    });
  });

  describe("manage_payees", () => {
    it("requires write scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "New Payee" }] },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("creates a single payee on success", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "New Payee" }] },
        { sessionId: "s1" },
      );
      expect(payeesService.create).toHaveBeenCalledWith("u1", {
        name: "New Payee",
        defaultCategoryId: undefined,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("p2");
      expect(parsed.count).toBe(1);
    });

    it("updates a single payee on success", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      const result = await handlers["manage_payees"](
        {
          operation: "update",
          items: [{ name: "Old", newName: "New Payee" }],
        },
        { sessionId: "s1" },
      );
      expect(payeesService.update).toHaveBeenCalledWith("u1", "p2", {
        name: "New Payee",
        defaultCategoryId: null,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
    });

    it("deletes a single payee on success", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      const result = await handlers["manage_payees"](
        { operation: "delete", items: [{ name: "Old Payee" }] },
        { sessionId: "s1" },
      );
      expect(payeesService.remove).toHaveBeenCalledWith("u1", "p2");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.deleted).toBe(true);
    });

    it("does not write when the user declines the confirmation", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "decline" });

      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "New Payee" }] },
        { sessionId: "s1" },
      );

      expect(prepService.prepareCreatePayeeSingle).toHaveBeenCalled();
      expect(payeesService.create).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("declined");
    });

    it("shows a web-chat card (no write) when serving a relayed prompt", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      relayService.emitPendingAction.mockReturnValue(true);

      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "New Payee" }] },
        { sessionId: "s1", requestId: "call-1" },
      );

      expect(relayService.emitPendingAction).toHaveBeenCalled();
      expect(payeesService.create).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe("preview_shown");
    });

    it("returns a dry-run preview without writing", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      prepService.prepareCreatePayees.mockResolvedValue({
        okPreviews: [{ name: "New Payee" }],
        okRows: [{ name: "New Payee", defaultCategoryId: null }],
        previewRows: [{ status: "ok", name: "New Payee" }],
        okIndex: [0],
        skipped: [],
      });

      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "New Payee" }], dryRun: true },
        { sessionId: "s1" },
      );

      expect(payeesService.create).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.operation).toBe("create");
    });

    it("creates multiple payees as one bulk card via confirmation", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      prepService.prepareCreatePayees.mockResolvedValue({
        okPreviews: [
          { name: "A", defaultCategoryId: null, defaultCategoryName: null },
          { name: "B", defaultCategoryId: null, defaultCategoryName: null },
        ],
        okRows: [
          { name: "A", defaultCategoryId: null },
          { name: "B", defaultCategoryId: null },
        ],
        previewRows: [
          { status: "ok", name: "A" },
          { status: "ok", name: "B" },
        ],
        okIndex: [0, 1],
        skipped: [],
      });

      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "A" }, { name: "B" }] },
        { sessionId: "s1" },
      );

      expect(actionBuilder.buildBatchActions).toHaveBeenCalledWith(
        "u1",
        "create_payee",
        expect.any(Array),
        expect.any(Array),
      );
      expect(payeesService.create).toHaveBeenCalledTimes(2);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(2);
    });

    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "X" }] },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("returns error when prep throws", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      prepService.prepareCreatePayeeSingle.mockRejectedValue(new Error("dup"));
      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "X" }] },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });
  });
});
