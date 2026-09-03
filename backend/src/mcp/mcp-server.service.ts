import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/server";
import { AiRelayService } from "../ai/relay/ai-relay.service";
import { installRelayToolActivity } from "./mcp-relay-tool-activity";
import { McpAccountsTools } from "./tools/accounts.tool";
import { McpTransactionsTools } from "./tools/transactions.tool";
import { McpCategoriesTools } from "./tools/categories.tool";
import { McpPayeesTools } from "./tools/payees.tool";
import { McpReportsTools } from "./tools/reports.tool";
import { McpInvestmentsTools } from "./tools/investments.tool";
import { McpScheduledTools } from "./tools/scheduled.tool";
import { McpCalculateTools } from "./tools/calculate.tool";
import { McpBudgetsTools } from "./tools/budgets.tool";
import { McpRelayTools } from "./tools/relay.tool";
import { McpAccountListResource } from "./resources/account-list.resource";
import { McpCategoryTreeResource } from "./resources/category-tree.resource";
import { McpRecentTransactionsResource } from "./resources/recent-transactions.resource";
import { McpFinancialSummaryResource } from "./resources/financial-summary.resource";
import { McpRelayAttachmentResource } from "./resources/relay-attachment.resource";
import { McpFinancialReviewPrompt } from "./prompts/financial-review.prompt";
import { McpBudgetCheckPrompt } from "./prompts/budget-check.prompt";
import { McpTransactionLookupPrompt } from "./prompts/transaction-lookup.prompt";
import { McpSpendingAnalysisPrompt } from "./prompts/spending-analysis.prompt";

// Version comes from the backend package.json at build/run time so the MCP
// server advertises the same version as the published image. Using require
// keeps the read synchronous and avoids ESM import-assertion issues.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const backendPkg = require("../../package.json") as { version: string };

@Injectable()
export class McpServerService {
  constructor(
    private readonly accountsTools: McpAccountsTools,
    private readonly transactionsTools: McpTransactionsTools,
    private readonly categoriesTools: McpCategoriesTools,
    private readonly payeesTools: McpPayeesTools,
    private readonly reportsTools: McpReportsTools,
    private readonly investmentsTools: McpInvestmentsTools,
    private readonly scheduledTools: McpScheduledTools,
    private readonly calculateTools: McpCalculateTools,
    private readonly budgetsTools: McpBudgetsTools,
    private readonly relayTools: McpRelayTools,
    private readonly relayService: AiRelayService,
    private readonly accountListResource: McpAccountListResource,
    private readonly categoryTreeResource: McpCategoryTreeResource,
    private readonly recentTransactionsResource: McpRecentTransactionsResource,
    private readonly financialSummaryResource: McpFinancialSummaryResource,
    private readonly relayAttachmentResource: McpRelayAttachmentResource,
    private readonly financialReviewPrompt: McpFinancialReviewPrompt,
    private readonly budgetCheckPrompt: McpBudgetCheckPrompt,
    private readonly transactionLookupPrompt: McpTransactionLookupPrompt,
    private readonly spendingAnalysisPrompt: McpSpendingAnalysisPrompt,
  ) {}

  /**
   * One factory for both eras, so a 2026-07-28 client and a 2025-era client can
   * never be served a different set of tools. The modern handler calls it per
   * request and the sessionful path once per session.
   */
  createServer(opts: { era?: "legacy" | "modern" } = {}): McpServer {
    void opts.era;
    // Surface today's date so the model can resolve relative ranges ("this
    // month", "last 30 days") into YYYY-MM-DD without an extra round trip. A
    // server is built per 2025-era session and per 2026-07-28 request, so this
    // is never staler than the connection.
    const today = new Date().toISOString().substring(0, 10);
    const server = new McpServer(
      { name: "monize", version: backendPkg.version },
      {
        instructions: [
          "Monize is a personal finance management service: accounts, transactions, investments, budgets and reports for one user.",
          "",
          `Today is ${today}. Resolve relative ranges ('this month', 'last 30 days') against it and pass YYYY-MM-DD; report months are YYYY-MM.`,
          "",
          "## Conventions",
          "- Amounts are signed: positive is income or a deposit, negative an expense or withdrawal.",
          "- Account, category and payee NAMES resolve internally on every tool that takes them, reads and writes alike. Look an id up only where a field asks for one.",
          '- A category is named "Parent: Child"; a bare child name shared by two parents is rejected rather than guessed.',
          "- A null total means a component could not be priced or converted, never zero. Any partial sum travels beside it under its own name -- quote that as a subtotal, and say which currency a total is in.",
          "- Never do arithmetic yourself: use calculate, and present a value a tool already computed as it stands.",
          "",
          "## Writing",
          "- manage_transactions, manage_payees, manage_securities and manage_investment_transactions each take operation = create/update/delete and 1-25 items.",
          "- Every write is confirmed by the user before it is saved. By default 6 or more items are confirmed as one batch and 1-5 one at a time; approvalMode 'individual' forces one each. dryRun previews without saving.",
          "",
          "## Choosing a tool",
          "- Spending, income or trends: generate_report. Prefer it over listing transactions.",
          "- Net worth and balances: list_accounts.",
          "- Specific transactions: list_transactions, and only then with includeTransactions.",
          "- Upcoming bills: list_upcoming_bills. Investments: get_portfolio_summary, which includes a per-account breakdown.",
          "- monize://financial-summary answers a snapshot question with no tool call; monize://accounts and monize://categories resolve names to ids.",
          "",
          "## Web-chat relay",
          "- When get_next_prompt hands you a prompt, its `guidance` field says how to report progress, batch work and finish the turn. Follow it.",
        ].join("\n"),
        capabilities: {
          logging: {},
          tools: {},
          resources: {},
          prompts: {},
        },
      },
    );

    // Stream the agent's tool calls to the web chat as live progress when this
    // session is serving a relayed prompt. Must run before the tools register.
    installRelayToolActivity(server, this.relayService);

    this.accountsTools.register(server);
    this.transactionsTools.register(server);
    this.categoriesTools.register(server);
    this.payeesTools.register(server);
    this.reportsTools.register(server);
    this.investmentsTools.register(server);
    this.scheduledTools.register(server);
    this.calculateTools.register(server);
    this.budgetsTools.register(server);
    this.relayTools.register(server);

    this.accountListResource.register(server);
    this.categoryTreeResource.register(server);
    this.recentTransactionsResource.register(server);
    this.financialSummaryResource.register(server);
    this.relayAttachmentResource.register(server);

    this.financialReviewPrompt.register(server);
    this.budgetCheckPrompt.register(server);
    this.transactionLookupPrompt.register(server);
    this.spendingAnalysisPrompt.register(server);

    return server;
  }
}
