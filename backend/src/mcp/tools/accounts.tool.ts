import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountsService } from "../../accounts/accounts.service";
import { AccountType } from "../../accounts/entities/account.entity";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { listAccountsOutput } from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";
import { uuidString } from "./schema-fragments";

@Injectable()
export class McpAccountsTools {
  constructor(private readonly accountsService: AccountsService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "list_accounts",
      {
        title: "List accounts",
        annotations: READ_ONLY,
        description:
          "The user's accounts and an assets / liabilities / net-worth summary " +
          "matching the dashboard. Use it for any question about which accounts " +
          "they have or how much money is in one. A brokerage account's " +
          "`balance` is its market value; every other account's includes future " +
          "transactions, with the through-today figure in `currentBalance`. " +
          "Loan and mortgage rows carry their payment schedule. `totalAccounts` " +
          "counts what is left AFTER filtering.",
        inputSchema: {
          accountNames: z
            .array(z.string().max(100))
            .max(100)
            .optional()
            .describe("Exact account names, case-insensitive."),
          accountIds: z.array(uuidString()).optional().describe("Account ids."),
          nameQuery: z
            .string()
            .max(100)
            .optional()
            .describe("Case-insensitive substring of the account name."),
          status: z
            .enum(["open", "closed", "all"])
            .optional()
            .describe("Defaults to 'open'."),
          accountTypes: z
            .array(z.nativeEnum(AccountType))
            .max(10)
            .optional()
            .describe("Omit to include every type."),
        },
        outputSchema: listAccountsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          // Service owns the "open" default so it stays in one place.
          const data = await this.accountsService.getLlmAccounts(ctx.userId, {
            accountNames: args.accountNames,
            accountIds: args.accountIds,
            nameQuery: args.nameQuery,
            status: args.status,
            accountTypes: args.accountTypes,
          });
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
