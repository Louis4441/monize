import { McpTransactionsTools } from "./transactions.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpTransactionsTools", () => {
  let tool: McpTransactionsTools;
  let transactionsService: Record<string, jest.Mock>;
  let analyticsService: Record<string, jest.Mock>;
  let server: {
    registerTool: jest.Mock;
    server: { getClientCapabilities: jest.Mock; elicitInput: jest.Mock };
  };
  let elicitInput: jest.Mock;
  let relayService: { emitPendingAction: jest.Mock };
  let actionBuilder: Record<string, jest.Mock>;
  let prepService: Record<string, jest.Mock>;
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    transactionsService = {
      findAll: jest.fn(),
      getLlmTransactionRows: jest.fn(),
      previewCreate: jest.fn(),
      previewCategorize: jest.fn().mockResolvedValue({
        transactionId: "t1",
        payeeName: "Store",
        amount: -50,
        transactionDate: "2025-01-15",
        accountName: "Checking",
        currentCategoryName: "Uncategorized",
        categoryId: "c1",
        newCategoryName: "Groceries",
      }),
      create: jest.fn(),
      createBulk: jest.fn(),
      update: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
      previewUpdate: jest.fn(),
      previewDelete: jest.fn(),
      createTransfer: jest.fn(),
      updateTransfer: jest.fn(),
    };

    analyticsService = {
      getTransfersByAccount: jest.fn(),
      getLlmQueryTransactions: jest.fn(),
      getLlmSpendingByCategory: jest.fn(),
      getLlmIncomeSummary: jest.fn(),
      getLlmPeriodComparison: jest.fn(),
    };

    // Default: not serving a relayed prompt, so the tool uses its normal
    // (direct MCP-client) confirmation path and the existing assertions hold.
    relayService = { emitPendingAction: jest.fn().mockReturnValue(false) };
    actionBuilder = {
      buildCreateTransaction: jest
        .fn()
        .mockReturnValue({ type: "create_transaction", preview: {} }),
      buildCreateTransactions: jest
        .fn()
        .mockReturnValue({ type: "create_transactions", preview: {} }),
      buildCategorizeTransaction: jest.fn().mockReturnValue({}),
      buildUpdateTransaction: jest
        .fn()
        .mockReturnValue({ type: "update_transaction", preview: {} }),
      buildDeleteTransaction: jest
        .fn()
        .mockReturnValue({ type: "delete_transaction", preview: {} }),
      buildCreateTransfer: jest
        .fn()
        .mockReturnValue({ type: "create_transfer", preview: {} }),
      buildUpdateTransfer: jest
        .fn()
        .mockReturnValue({ type: "update_transfer", preview: {} }),
      buildBatchActions: jest
        .fn()
        .mockReturnValue({ type: "batch_actions", preview: {} }),
    };
    prepService = {
      prepareCreate: jest.fn(),
      prepareCreateTransfer: jest.fn().mockResolvedValue({
        okPreviews: [],
        okIndex: [],
        previewRows: [],
        skipped: [],
      }),
      prepareCreateSingle: jest.fn(),
      prepareCreateTransferSingle: jest.fn(),
      prepareUpdate: jest.fn(),
      prepareUpdateBulk: jest.fn(),
      prepareDelete: jest.fn(),
      prepareDeleteBulk: jest.fn(),
      transferToBatchRow: jest.fn((p) => p),
    };

    tool = new McpTransactionsTools(
      transactionsService as any,
      analyticsService as any,
      relayService as any,
      actionBuilder as any,
      prepService as any,
    );

    elicitInput = jest.fn();
    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
      // confirmWrite() reads capabilities + elicits via server.server. Default
      // to no elicitation capability so writes proceed (matches a client that
      // can't show a dialog); accept/decline tests override these.
      server: {
        getClientCapabilities: jest.fn().mockReturnValue({}),
        elicitInput,
      },
    };

    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("should register 7 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(7);
  });

  describe("query_transactions", () => {
    it("delegates to analyticsService.getLlmQueryTransactions", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmQueryTransactions.mockResolvedValue({
        totalIncome: 0,
        totalExpenses: 0,
        netCashFlow: 0,
        transactionCount: 0,
      });

      await handlers["query_transactions"](
        { startDate: "2026-01-01", endDate: "2026-01-31", groupBy: "category" },
        { sessionId: "s1" },
      );

      expect(analyticsService.getLlmQueryTransactions).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          groupBy: "category",
        }),
      );
    });

    it("fills in default dates when startDate/endDate are omitted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmQueryTransactions.mockResolvedValue({
        totalIncome: 0,
        totalExpenses: 0,
        netCashFlow: 0,
        transactionCount: 0,
      });

      await handlers["query_transactions"]({}, { sessionId: "s1" });

      expect(analyticsService.getLlmQueryTransactions).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      );
    });
  });

  describe("get_spending_by_category", () => {
    it("delegates to analyticsService.getLlmSpendingByCategory", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmSpendingByCategory.mockResolvedValue({
        categories: [],
        totalSpending: 0,
      });

      await handlers["get_spending_by_category"](
        { startDate: "2026-01-01", endDate: "2026-01-31", topN: 5 },
        { sessionId: "s1" },
      );

      expect(analyticsService.getLlmSpendingByCategory).toHaveBeenCalledWith(
        "u1",
        "2026-01-01",
        "2026-01-31",
        5,
      );
    });

    it("defaults topN to 10 and fills in dates when omitted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmSpendingByCategory.mockResolvedValue({
        categories: [],
        totalSpending: 0,
      });

      await handlers["get_spending_by_category"]({}, { sessionId: "s1" });

      expect(analyticsService.getLlmSpendingByCategory).toHaveBeenCalledWith(
        "u1",
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        10,
      );
    });
  });

  describe("get_income_summary", () => {
    it("delegates to analyticsService.getLlmIncomeSummary with default groupBy", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmIncomeSummary.mockResolvedValue({
        items: [],
        totalIncome: 0,
        groupedBy: "category",
      });

      await handlers["get_income_summary"](
        { startDate: "2026-01-01", endDate: "2026-01-31" },
        { sessionId: "s1" },
      );

      expect(analyticsService.getLlmIncomeSummary).toHaveBeenCalledWith(
        "u1",
        "2026-01-01",
        "2026-01-31",
        "category",
      );
    });

    it("fills in default dates when omitted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmIncomeSummary.mockResolvedValue({
        items: [],
        totalIncome: 0,
        groupedBy: "category",
      });

      await handlers["get_income_summary"]({}, { sessionId: "s1" });

      expect(analyticsService.getLlmIncomeSummary).toHaveBeenCalledWith(
        "u1",
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        "category",
      );
    });
  });

  describe("compare_periods", () => {
    it("delegates to analyticsService.getLlmPeriodComparison", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmPeriodComparison.mockResolvedValue({
        period1: { start: "2025-12-01", end: "2025-12-31", total: 0 },
        period2: { start: "2026-01-01", end: "2026-01-31", total: 0 },
        totalChange: 0,
        totalChangePercent: 0,
        comparison: [],
      });

      await handlers["compare_periods"](
        {
          period1Start: "2025-12-01",
          period1End: "2025-12-31",
          period2Start: "2026-01-01",
          period2End: "2026-01-31",
        },
        { sessionId: "s1" },
      );

      expect(analyticsService.getLlmPeriodComparison).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          period1Start: "2025-12-01",
          period2Start: "2026-01-01",
        }),
      );
    });

    it("fills in all four dates when omitted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmPeriodComparison.mockResolvedValue({
        period1: { start: "", end: "", total: 0 },
        period2: { start: "", end: "", total: 0 },
        totalChange: 0,
        totalChangePercent: 0,
        comparison: [],
      });

      await handlers["compare_periods"]({}, { sessionId: "s1" });

      expect(analyticsService.getLlmPeriodComparison).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          period1Start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          period1End: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          period2Start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          period2End: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      );
    });
  });

  describe("get_transfers", () => {
    it("delegates to shared analytics service", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getTransfersByAccount.mockResolvedValue({
        accounts: [
          {
            accountName: "Savings",
            currency: "USD",
            inbound: 1500,
            outbound: 0,
            net: 1500,
            transferCount: 3,
          },
        ],
        totalInbound: 1500,
        totalOutbound: 0,
        transferCount: 3,
      });

      const result = await handlers["get_transfers"](
        { startDate: "2026-01-01", endDate: "2026-01-31" },
        { sessionId: "s1" },
      );

      expect(analyticsService.getTransfersByAccount).toHaveBeenCalledWith(
        "u1",
        "2026-01-01",
        "2026-01-31",
        undefined,
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalInbound).toBe(1500);
      expect(parsed.accounts).toHaveLength(1);
    });

    it("requires read scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      const result = await handlers["get_transfers"](
        { startDate: "2026-01-01", endDate: "2026-01-31" },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("passes accountIds filter through", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getTransfersByAccount.mockResolvedValue({
        accounts: [],
        totalInbound: 0,
        totalOutbound: 0,
        transferCount: 0,
      });

      await handlers["get_transfers"](
        {
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          accountIds: ["00000000-0000-0000-0000-000000000001"],
        },
        { sessionId: "s1" },
      );
      expect(analyticsService.getTransfersByAccount).toHaveBeenCalledWith(
        "u1",
        "2026-01-01",
        "2026-01-31",
        ["00000000-0000-0000-0000-000000000001"],
      );
    });

    it("fills in default dates when omitted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getTransfersByAccount.mockResolvedValue({
        accounts: [],
        totalInbound: 0,
        totalOutbound: 0,
        transferCount: 0,
      });

      await handlers["get_transfers"]({}, { sessionId: "s1" });

      expect(analyticsService.getTransfersByAccount).toHaveBeenCalledWith(
        "u1",
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        undefined,
      );
    });
  });

  describe("search_transactions", () => {
    it("should return error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["search_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("should require read scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      const result = await handlers["search_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("returns the rows the domain service produces", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      transactionsService.getLlmTransactionRows.mockResolvedValue({
        transactions: [
          {
            id: "t1",
            date: "2025-01-15",
            payeeName: "Store",
            categoryName: "Food",
            amount: -50,
            accountName: "Checking",
            description: "Groceries",
            status: "cleared",
          },
        ],
        total: 1,
        hasMore: false,
      });

      const result = await handlers["search_transactions"](
        { query: "store", limit: 10 },
        { sessionId: "s1" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.transactions).toHaveLength(1);
      expect(parsed.transactions[0].payeeName).toBe("Store");
      expect(parsed.total).toBe(1);
    });

    it("delegates the filter args to the domain service (thin adapter)", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      transactionsService.getLlmTransactionRows.mockResolvedValue({
        transactions: [],
        total: 0,
        hasMore: false,
      });

      await handlers["search_transactions"](
        {
          query: "q",
          accountId: "a1",
          categoryId: "c1",
          payeeId: "p1",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
          minAmount: -150,
          maxAmount: -10,
          limit: 999,
        },
        { sessionId: "s1" },
      );
      expect(transactionsService.getLlmTransactionRows).toHaveBeenCalledWith(
        "u1",
        {
          query: "q",
          accountId: "a1",
          categoryId: "c1",
          payeeId: "p1",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
          minAmount: -150,
          maxAmount: -10,
          limit: 999,
        },
      );
    });
  });

  describe("manage_transactions", () => {
    const stdPreview = {
      accountId: "a1",
      accountName: "Checking",
      amount: -50,
      transactionDate: "2025-01-15",
      payeeId: "p1",
      payeeName: "Store",
      payeeMatched: true,
      payeeWillBeCreated: false,
      categoryId: null,
      categoryName: null,
      description: null,
      currencyCode: "USD",
    };

    it("requires write scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      const result = await handlers["manage_transactions"](
        { operation: "create", items: [{ accountName: "Checking" }] },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("dryRun previews create rows without writing", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      prepService.prepareCreate.mockResolvedValue({
        okPreviews: [stdPreview],
        okCreatePayee: [true],
        okIndex: [0],
        previewRows: [{ status: "ok", accountName: "Checking" }],
        skipped: [],
      });

      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: [{ accountName: "Checking", amount: -50, date: "2025-01-15" }],
          dryRun: true,
        },
        { sessionId: "s1" },
      );

      expect(transactionsService.create).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.previews).toHaveLength(1);
    });

    it("creates a single standard transaction when the client cannot elicit", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      prepService.prepareCreate.mockResolvedValue({
        okPreviews: [stdPreview],
        okCreatePayee: [true],
        okIndex: [0],
        previewRows: [{ status: "ok" }],
        skipped: [],
      });
      transactionsService.create.mockResolvedValue({
        id: "t1",
        transactionDate: "2025-01-15",
      });

      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: [{ accountName: "Checking", amount: -50, date: "2025-01-15" }],
        },
        { sessionId: "s1" },
      );

      expect(transactionsService.create).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("t1");
      expect(parsed.count).toBe(1);
    });

    it("creates a single transfer when the item carries toAccountName", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      const xferPreview = {
        fromAccountId: "a1",
        fromAccountName: "Checking",
        fromCurrencyCode: "USD",
        toAccountId: "a2",
        toAccountName: "Savings",
        toCurrencyCode: "USD",
        amount: 100,
        toAmount: 100,
        exchangeRate: 1,
        transactionDate: "2025-01-15",
        description: null,
      };
      prepService.prepareCreate.mockResolvedValue({
        okPreviews: [],
        okCreatePayee: [],
        okIndex: [],
        previewRows: [],
        skipped: [],
      });
      prepService.prepareCreateTransfer.mockResolvedValue({
        okPreviews: [xferPreview],
        okIndex: [0],
        previewRows: [{ status: "ok" }],
        skipped: [],
      });
      transactionsService.createTransfer.mockResolvedValue({
        fromTransaction: { id: "tf1" },
        toTransaction: { id: "tf2" },
      });

      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: [
            {
              fromAccountName: "Checking",
              toAccountName: "Savings",
              amount: 100,
              date: "2025-01-15",
            },
          ],
        },
        { sessionId: "s1" },
      );

      expect(transactionsService.createTransfer).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("tf1");
    });

    it("bulk create (bulk mode) emits one relay card", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      relayService.emitPendingAction.mockReturnValue(true);
      prepService.prepareCreate.mockResolvedValue({
        okPreviews: [stdPreview, stdPreview],
        okCreatePayee: [true, true],
        okIndex: [0, 1],
        previewRows: [{ status: "ok" }, { status: "ok" }],
        skipped: [],
      });

      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: [
            { accountName: "Checking", amount: -50, date: "2025-01-15" },
            { accountName: "Checking", amount: -20, date: "2025-01-16" },
          ],
          approvalMode: "bulk",
        },
        { sessionId: "s1" },
      );

      expect(actionBuilder.buildCreateTransactions).toHaveBeenCalledTimes(1);
      expect(relayService.emitPendingAction).toHaveBeenCalledTimes(1);
      expect(transactionsService.create).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBeDefined();
    });

    it("bulk create (individual mode) emits one relay card per item", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      relayService.emitPendingAction.mockReturnValue(true);
      prepService.prepareCreate.mockResolvedValue({
        okPreviews: [stdPreview, stdPreview],
        okCreatePayee: [true, true],
        okIndex: [0, 1],
        previewRows: [{ status: "ok" }, { status: "ok" }],
        skipped: [],
      });

      await handlers["manage_transactions"](
        {
          operation: "create",
          items: [
            { accountName: "Checking", amount: -50, date: "2025-01-15" },
            { accountName: "Checking", amount: -20, date: "2025-01-16" },
          ],
          approvalMode: "individual",
        },
        { sessionId: "s1" },
      );

      expect(actionBuilder.buildCreateTransaction).toHaveBeenCalledTimes(2);
      expect(relayService.emitPendingAction).toHaveBeenCalledTimes(2);
    });

    it("updates a single transaction (standard) when the client cannot elicit", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      prepService.prepareUpdate.mockResolvedValue({
        kind: "standard",
        createPayee: true,
        preview: {
          transactionId: "t1",
          accountId: "a1",
          accountName: "Checking",
          amount: -75,
          transactionDate: "2025-02-01",
          payeeId: "p1",
          payeeName: "Store",
          payeeMatched: true,
          payeeWillBeCreated: false,
          categoryId: "c1",
          categoryName: "Groceries",
          description: null,
          currencyCode: "USD",
        },
      });
      transactionsService.update.mockResolvedValue({ id: "t1" });

      const result = await handlers["manage_transactions"](
        {
          operation: "update",
          items: [{ transactionId: "t1", amount: -75 }],
        },
        { sessionId: "s1" },
      );

      expect(transactionsService.update).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("t1");
    });

    it("routes a single transfer update through updateTransfer", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      prepService.prepareUpdate.mockResolvedValue({
        kind: "transfer",
        preview: {
          transactionId: "t1",
          fromAccountId: "a1",
          fromAccountName: "Checking",
          fromCurrencyCode: "USD",
          toAccountId: "a2",
          toAccountName: "Savings",
          toCurrencyCode: "USD",
          amount: 100,
          toAmount: 100,
          exchangeRate: 1,
          transactionDate: "2025-02-01",
          description: null,
        },
      });
      transactionsService.updateTransfer.mockResolvedValue({
        fromTransaction: { id: "t1" },
        toTransaction: { id: "t2" },
      });

      await handlers["manage_transactions"](
        {
          operation: "update",
          items: [{ transactionId: "t1", amount: 100 }],
        },
        { sessionId: "s1" },
      );

      expect(transactionsService.updateTransfer).toHaveBeenCalledTimes(1);
    });

    it("bulk update (bulk mode) builds one batch card", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      relayService.emitPendingAction.mockReturnValue(true);
      prepService.prepareUpdateBulk.mockResolvedValue({
        okRows: [
          {
            transactionId: "t1",
            accountId: "a1",
            amount: -5,
            transactionDate: "2025-01-01",
            payeeId: null,
            payeeName: null,
            createPayee: false,
            categoryId: "c1",
            description: null,
            currencyCode: "USD",
          },
        ],
        previewRows: [{ status: "ok" }],
        okIndex: [0],
        skipped: [],
      });

      await handlers["manage_transactions"](
        {
          operation: "update",
          items: [
            { transactionId: "t1", categoryName: "Groceries" },
            { transactionId: "t2", categoryName: "Groceries" },
          ],
          approvalMode: "bulk",
        },
        { sessionId: "s1" },
      );

      expect(actionBuilder.buildBatchActions).toHaveBeenCalledWith(
        "u1",
        "update",
        expect.any(Array),
        expect.any(Array),
      );
      expect(relayService.emitPendingAction).toHaveBeenCalledTimes(1);
    });

    it("deletes a single transaction when the client cannot elicit", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      prepService.prepareDelete.mockResolvedValue({
        transactionId: "t1",
        accountName: "Checking",
        amount: -75,
        transactionDate: "2025-02-01",
        payeeName: "Store",
        categoryName: "Groceries",
        description: null,
        currencyCode: "USD",
      });

      const result = await handlers["manage_transactions"](
        { operation: "delete", items: [{ transactionId: "t1" }] },
        { sessionId: "s1" },
      );

      expect(transactionsService.remove).toHaveBeenCalledWith("u1", "t1");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.deleted).toBe(true);
    });

    it("bulk delete (bulk mode) builds one batch card", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      relayService.emitPendingAction.mockReturnValue(true);
      prepService.prepareDeleteBulk.mockResolvedValue({
        okRows: [{ transactionId: "t1" }, { transactionId: "t2" }],
        previewRows: [{ status: "ok" }, { status: "ok" }],
        okIndex: [0, 1],
        skipped: [],
      });

      await handlers["manage_transactions"](
        {
          operation: "delete",
          items: [{ transactionId: "t1" }, { transactionId: "t2" }],
          approvalMode: "bulk",
        },
        { sessionId: "s1" },
      );

      expect(actionBuilder.buildBatchActions).toHaveBeenCalledWith(
        "u1",
        "delete",
        expect.any(Array),
        expect.any(Array),
      );
    });
  });
});
