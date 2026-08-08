import { readFileSync } from "fs";
import { join } from "path";
import { Logger } from "@nestjs/common";
import {
  QUERY_BUDGET_SPECS,
  QueryBudgetKey,
  resolveQueryBudgets,
} from "./query-budgets";

const budgetKeys = Object.keys(QUERY_BUDGET_SPECS) as QueryBudgetKey[];

/** A ConfigService stand-in backed by a plain map of env values. */
const readerFor = (values: Record<string, unknown>) => ({
  get: (key: string) => values[key],
});

const makeLogger = () => {
  const logger = { log: jest.fn(), warn: jest.fn() };
  return logger as unknown as Logger & typeof logger;
};

describe("resolveQueryBudgets", () => {
  it("falls back to every default when no config is supplied at all", () => {
    const budgets = resolveQueryBudgets();

    expect(budgets).toEqual({
      maxIterations: 5,
      maxToolCalls: 15,
      queryTimeoutMs: 20 * 60 * 1000,
      maxInputTokens: 200_000,
      maxToolResultChars: 50_000,
    });
  });

  it("falls back to every default when the config has no overrides", () => {
    expect(resolveQueryBudgets(readerFor({}))).toEqual(resolveQueryBudgets());
  });

  it("applies every override, including a value below the default", () => {
    const budgets = resolveQueryBudgets(
      readerFor({
        AI_QUERY_MAX_ITERATIONS: "12",
        AI_QUERY_MAX_TOOL_CALLS: "40",
        AI_QUERY_TIMEOUT_MINUTES: "3",
        AI_QUERY_MAX_INPUT_TOKENS: "50000",
        AI_QUERY_MAX_TOOL_RESULT_CHARS: "10000",
      }),
    );

    expect(budgets).toEqual({
      maxIterations: 12,
      maxToolCalls: 40,
      queryTimeoutMs: 3 * 60 * 1000,
      maxInputTokens: 50_000,
      maxToolResultChars: 10_000,
    });
  });

  it("converts the timeout from minutes to milliseconds", () => {
    // The env var is in minutes for readability; the loop compares a ms delta.
    // Getting this backwards would give a 20-millisecond query budget.
    expect(
      resolveQueryBudgets(readerFor({ AI_QUERY_TIMEOUT_MINUTES: 1 }))
        .queryTimeoutMs,
    ).toBe(60_000);
  });

  it("accepts a numeric value as well as the string env vars arrive as", () => {
    expect(
      resolveQueryBudgets(readerFor({ AI_QUERY_MAX_ITERATIONS: 9 }))
        .maxIterations,
    ).toBe(9);
  });

  describe.each([
    ["a non-numeric string", "ten"],
    ["zero", "0"],
    ["a negative number", "-5"],
    ["a fraction", "2.5"],
    ["a boolean-ish string", "true"],
    ["Infinity", "Infinity"],
    ["NaN", Number.NaN],
  ])("rejects %s", (_label, raw) => {
    it("keeps the default and warns", () => {
      const logger = makeLogger();
      const budgets = resolveQueryBudgets(
        readerFor({ AI_QUERY_MAX_ITERATIONS: raw }),
        logger,
      );

      expect(budgets.maxIterations).toBe(
        QUERY_BUDGET_SPECS.maxIterations.default,
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("AI_QUERY_MAX_ITERATIONS"),
      );
    });
  });

  it.each([
    ["an unset variable", undefined],
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
  ])("treats %s as absent rather than invalid", (_label, raw) => {
    const logger = makeLogger();
    const budgets = resolveQueryBudgets(
      readerFor({ AI_QUERY_MAX_ITERATIONS: raw }),
      logger,
    );

    expect(budgets.maxIterations).toBe(
      QUERY_BUDGET_SPECS.maxIterations.default,
    );
    // An operator who set nothing has made no mistake, so nothing is logged.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("logs an accepted override so the effective budget is visible", () => {
    const logger = makeLogger();
    resolveQueryBudgets(readerFor({ AI_QUERY_MAX_TOOL_CALLS: "30" }), logger);

    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("AI_QUERY_MAX_TOOL_CALLS=30"),
    );
  });

  it("does not log an override that merely restates the default", () => {
    const logger = makeLogger();
    resolveQueryBudgets(
      readerFor({
        AI_QUERY_MAX_TOOL_CALLS: String(
          QUERY_BUDGET_SPECS.maxToolCalls.default,
        ),
      }),
      logger,
    );

    expect(logger.log).not.toHaveBeenCalled();
  });

  it("resolves each budget from its own variable, not a shared one", () => {
    // One spec object copied and edited is the easy mistake here: every budget
    // would read the same env var and move together.
    for (const key of budgetKeys) {
      const spec = QUERY_BUDGET_SPECS[key];
      const budgets = resolveQueryBudgets(
        readerFor({ [spec.envVar]: spec.default + 1 }),
      );
      const others = budgetKeys.filter((k) => k !== key);
      for (const other of others) {
        const otherSpec = QUERY_BUDGET_SPECS[other];
        const value =
          other === "timeoutMinutes"
            ? budgets.queryTimeoutMs / 60_000
            : (budgets as unknown as Record<string, number>)[other];
        expect({ key, other, value }).toEqual({
          key,
          other,
          value: otherSpec.default,
        });
      }
    }
  });

  it("works when the config throws for unknown keys", () => {
    // Belt and braces: a reader that is strict about unknown keys must not
    // take the whole assistant down at construction time.
    const strict = {
      get: (key: string) => {
        if (!budgetKeys.some((k) => QUERY_BUDGET_SPECS[k].envVar === key)) {
          throw new Error(`unknown key ${key}`);
        }
        return undefined;
      },
    };
    expect(() => resolveQueryBudgets(strict)).not.toThrow();
  });
});

describe("QUERY_BUDGET_SPECS", () => {
  it("gives every budget a distinct AI_QUERY_-prefixed variable", () => {
    const names = budgetKeys.map((k) => QUERY_BUDGET_SPECS[k].envVar);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^AI_QUERY_[A-Z_]+$/);
    }
  });

  it("gives every budget a positive integer default and a description", () => {
    for (const key of budgetKeys) {
      const spec = QUERY_BUDGET_SPECS[key];
      expect(Number.isInteger(spec.default) && spec.default > 0).toBe(true);
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  // A knob nobody can find is not configurable. `.env.example` is the only
  // place an operator looks, so a new budget that never reaches it ships
  // undiscoverable -- and a documented default that has drifted from the code
  // is worse than none, because it is believed.
  describe(".env.example parity", () => {
    const envExample = readFileSync(
      join(__dirname, "..", "..", "..", "..", ".env.example"),
      "utf8",
    );

    it.each(budgetKeys)("documents %s with its current default", (key) => {
      const spec = QUERY_BUDGET_SPECS[key];
      expect(envExample).toContain(`# ${spec.envVar}=${spec.default}`);
    });

    it("documents no AI_QUERY_ variable the code does not read", () => {
      const documented = [
        ...envExample.matchAll(/^#\s*(AI_QUERY_[A-Z_]+)=/gm),
      ].map((m) => m[1]);
      const known = budgetKeys.map((k) => QUERY_BUDGET_SPECS[k].envVar);
      expect([...new Set(documented)].sort()).toEqual([...known].sort());
    });
  });
});
