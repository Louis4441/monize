import "reflect-metadata";
import {
  listTransactionRulesSchema,
  manageTransactionRulesSchema,
  validateToolInput,
} from "./tool-input-schemas";

const RULE = "e0000000-0000-4000-8000-000000000005";
const condition = { field: "payeeId", op: "eq", value: "Netflix" };
const actions = [{ type: "set_category", categoryName: "Streaming" }];

describe("transaction rule tool schemas", () => {
  describe("list_transaction_rules", () => {
    it("accepts no input, a search, a ruleId and a numeric-string limit", () => {
      expect(listTransactionRulesSchema.safeParse({}).success).toBe(true);
      const parsed = listTransactionRulesSchema.parse({
        search: "stream",
        ruleId: RULE,
        limit: "25",
      });
      expect(parsed.limit).toBe(25);
    });

    it.each([{ limit: 0 }, { limit: 201 }, { ruleId: "nope" }, { limit: "" }])(
      "rejects %j",
      (input) => {
        expect(listTransactionRulesSchema.safeParse(input).success).toBe(false);
      },
    );
  });

  describe("manage_transaction_rules", () => {
    it.each([
      [{ operation: "create", name: "Streaming", condition, actions }],
      [{ operation: "update", ruleId: RULE, name: "New" }],
      [{ operation: "update", ruleId: RULE, enabled: "false" }],
      [{ operation: "delete", ruleId: RULE }],
      [{ operation: "run", ruleId: RULE, accountNames: ["Checking"] }],
      [{ operation: "test", ruleId: RULE }],
      [{ operation: "test", condition, actions }],
    ])("accepts %j", (input) => {
      expect(manageTransactionRulesSchema.safeParse(input).success).toBe(true);
    });

    it.each([
      ["create without a name", { operation: "create", condition, actions }],
      [
        "create without a condition",
        { operation: "create", name: "x", actions },
      ],
      ["create without actions", { operation: "create", name: "x", condition }],
      ["update without a ruleId", { operation: "update", name: "x" }],
      ["update with nothing to change", { operation: "update", ruleId: RULE }],
      ["delete without a ruleId", { operation: "delete" }],
      ["run without a ruleId", { operation: "run" }],
      ["test with neither", { operation: "test" }],
      ["test with half a draft", { operation: "test", condition }],
      ["an unknown operation", { operation: "merge", ruleId: RULE }],
      ["a ruleId that is not a UUID", { operation: "delete", ruleId: "nope" }],
      [
        "a trigger that does not exist",
        { operation: "update", ruleId: RULE, triggers: ["nightly"] },
      ],
      [
        "an empty trigger list",
        { operation: "update", ruleId: RULE, triggers: [] },
      ],
      [
        "an empty action list",
        { operation: "update", ruleId: RULE, actions: [] },
      ],
      [
        "more than 10 actions",
        {
          operation: "update",
          ruleId: RULE,
          actions: Array.from({ length: 11 }, () => ({ type: "add_tags" })),
        },
      ],
      [
        "a limit over the run ceiling",
        { operation: "run", ruleId: RULE, limit: 1001 },
      ],
      [
        "a date that is not YYYY-MM-DD",
        { operation: "run", ruleId: RULE, startDate: "1 Jan" },
      ],
      [
        "more than 100 accounts",
        {
          operation: "run",
          ruleId: RULE,
          accountNames: Array.from({ length: 101 }, () => "A"),
        },
      ],
      [
        "a condition that is not an object",
        { operation: "test", condition: "all", actions },
      ],
      [
        "an oversized condition",
        { operation: "test", condition: { all: "x".repeat(20001) }, actions },
      ],
    ])("rejects %s", (_name, input) => {
      expect(manageTransactionRulesSchema.safeParse(input).success).toBe(false);
    });

    it("reads a string limit and a string boolean the way the other tools do", () => {
      const parsed = manageTransactionRulesSchema.parse({
        operation: "run",
        ruleId: RULE,
        limit: "50",
      });
      expect(parsed.limit).toBe(50);
      const disabled = manageTransactionRulesSchema.parse({
        operation: "update",
        ruleId: RULE,
        enabled: "false",
      });
      expect(disabled.enabled).toBe(false);
    });

    it("is what validateToolInput applies to both tools", () => {
      expect(
        validateToolInput("manage_transaction_rules", { operation: "delete" })
          .success,
      ).toBe(false);
      expect(
        validateToolInput("list_transaction_rules", { limit: "3" }),
      ).toEqual({ success: true, data: { limit: 3 } });
    });
  });
});
