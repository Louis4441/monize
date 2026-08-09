import { Logger } from "@nestjs/common";
import { resolvePositiveInt } from "../../common/env-number.util";

/**
 * Per-query resource budgets for the AI Assistant's tool-calling loop.
 *
 * These are deployment knobs, not user preferences: what a sensible ceiling is
 * depends on the provider behind the assistant. A hosted frontier model plans
 * several tool calls per turn and finishes a multi-step question inside the
 * defaults; a small local Ollama model tends to issue one lookup per turn and
 * runs out of iterations mid-investigation. Rather than pick one number for
 * both, every budget reads from an environment variable and falls back to the
 * default below.
 *
 * The whole set is declared as data -- default, env var name and unit in one
 * table -- so a new budget cannot be added without a name and cannot drift out
 * of sync with `.env.example`, which `query-budgets.spec.ts` checks in both
 * directions.
 */

/** A budget's default value, the env var that overrides it, and its unit. */
export interface QueryBudgetSpec {
  readonly envVar: string;
  readonly default: number;
  readonly description: string;
}

export const QUERY_BUDGET_SPECS = {
  /**
   * Maximum trips through the tool-calling loop. Binds before `maxToolCalls`
   * for any model that issues a single tool call per turn, which is the common
   * shape for smaller local models.
   */
  maxIterations: {
    envVar: "AI_QUERY_MAX_ITERATIONS",
    default: 5,
    description: "analysis steps (tool-calling loop iterations) per query",
  },
  /** LLM04-F1: maximum total tool calls per query across all iterations. */
  maxToolCalls: {
    envVar: "AI_QUERY_MAX_TOOL_CALLS",
    default: 15,
    description: "data lookups (tool calls) per query",
  },
  /**
   * LLM04-F2: overall wall-clock budget for one query, in minutes.
   *
   * Independent of the per-provider timeout (e.g. Ollama's 15-minute one),
   * which stays untouched so scheduled tasks calling the provider directly
   * still get the full provider window.
   */
  timeoutMinutes: {
    envVar: "AI_QUERY_TIMEOUT_MINUTES",
    default: 20,
    description: "wall-clock minutes before a query is cut short",
  },
  /** LLM04-F3: maximum cumulative input tokens before aborting the query. */
  maxInputTokens: {
    envVar: "AI_QUERY_MAX_INPUT_TOKENS",
    default: 200_000,
    description: "cumulative input tokens per query",
  },
  /** LLM08-F2: maximum size of a single tool result message, in characters. */
  maxToolResultChars: {
    envVar: "AI_QUERY_MAX_TOOL_RESULT_CHARS",
    default: 50_000,
    description: "characters kept from a single tool result",
  },
} as const satisfies Record<string, QueryBudgetSpec>;

export type QueryBudgetKey = keyof typeof QUERY_BUDGET_SPECS;

/** Resolved budgets, in the units the loop actually uses. */
export interface QueryBudgets {
  maxIterations: number;
  maxToolCalls: number;
  /** Derived from `timeoutMinutes`; the loop compares against a ms delta. */
  queryTimeoutMs: number;
  maxInputTokens: number;
  maxToolResultChars: number;
}

/** Minimal surface needed to read config, so tests need not build a module. */
export interface BudgetConfigReader {
  get(key: string): unknown;
}

/**
 * Resolve every budget from configuration, falling back to the defaults.
 *
 * An override that is not a positive integer is refused and logged at warn:
 * running on the default is the right behaviour, but doing it silently leaves
 * an operator believing a typo took effect. Accepted overrides are logged too,
 * so the effective budget of a running instance is visible in its startup log
 * rather than inferable only from the environment.
 */
export function resolveQueryBudgets(
  config?: BudgetConfigReader,
  logger?: Logger,
): QueryBudgets {
  const resolved = {} as Record<QueryBudgetKey, number>;

  for (const [key, spec] of Object.entries(QUERY_BUDGET_SPECS) as Array<
    [QueryBudgetKey, QueryBudgetSpec]
  >) {
    const raw = config?.get(spec.envVar);
    const { value, invalid } = resolvePositiveInt(raw, spec.default);
    if (invalid) {
      logger?.warn(
        `Ignoring ${spec.envVar}=${String(raw)}: expected a positive integer (${spec.description}). Using default ${spec.default}.`,
      );
    } else if (value !== spec.default) {
      logger?.log(
        `${spec.envVar}=${value} overrides the default ${spec.default} (${spec.description}).`,
      );
    }
    resolved[key] = value;
  }

  return {
    maxIterations: resolved.maxIterations,
    maxToolCalls: resolved.maxToolCalls,
    queryTimeoutMs: resolved.timeoutMinutes * 60 * 1000,
    maxInputTokens: resolved.maxInputTokens,
    maxToolResultChars: resolved.maxToolResultChars,
  };
}
