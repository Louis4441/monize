import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ScheduledInvestmentTransactionsService } from "../../scheduled-investment-transactions/scheduled-investment-transactions.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";

@Injectable()
export class McpScheduledInvestmentsTool {
  constructor(
    private readonly scheduledInvestmentService: ScheduledInvestmentTransactionsService,
  ) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_scheduled_investments",
      {
        description:
          "List recurring investment transactions (DCA, dividends, DRIP, contribution+buy) due in the next N days",
        inputSchema: {
          days: z
            .number()
            .min(1)
            .max(365)
            .optional()
            .default(30)
            .describe("Number of days to look ahead (default 30)"),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const data = await this.scheduledInvestmentService.getLlmUpcoming(
            ctx.userId,
            args.days || 30,
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
