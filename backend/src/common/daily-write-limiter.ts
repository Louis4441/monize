/**
 * Per-user daily write limiter shared by the surfaces that let an LLM mutate
 * a user's financial data (the MCP server tools and the AI Assistant action
 * confirmation endpoint). It caps how many write operations a single user can
 * perform in a UTC day so a misbehaving model -- or a user spamming
 * confirmations -- cannot make an unbounded number of modifications.
 *
 * The count is a row in `auth_attempt_counters`, read and written through
 * `AuthAttemptCounterService`, so every replica counts against the same number
 * and a restart or a rollout does not hand anybody a fresh allowance. What it
 * replaces was an array per process: N replicas meant N times the cap, and every
 * deploy reset it. It is still a soft guardrail rather than a security
 * boundary: `checkLimit` reads the count and the caller records after the write,
 * so two concurrent requests near the cap can both pass the read. The cap bounds
 * a runaway loop; it does not arbitrate a race.
 *
 * The window is fixed and ends at the next UTC midnight. The first write of the
 * day creates (or restarts) the row with `window_expires_at` at that midnight and
 * nothing moves it; every later comparison against it is made in SQL, so two
 * replicas agree about whether the day has turned however their clocks differ.
 *
 * The scope names the surface (`AI_WRITE_SCOPE`, `MCP_WRITE_SCOPE`); the two
 * surfaces keep separate budgets, as they did in memory. Scopes are the contract
 * between replicas: two processes must spell them the same way or they count
 * different things. The key is the plain `userId` -- it is not a secret, the
 * same choice the step-up scope makes on this RLS-exempt table.
 */

import { Logger } from "@nestjs/common";

import type { AuthAttemptCounterService } from "../auth/auth-attempt-counter.service";
import { resolvePositiveInt } from "./env-number.util";

/** Counter scope for writes confirmed through the AI Assistant. */
export const AI_WRITE_SCOPE = "ai-write";

/** Counter scope for writes made through the MCP server tools. */
export const MCP_WRITE_SCOPE = "mcp-write";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Milliseconds from `now` to the next UTC midnight: the length of the window a
 * day's first write opens. Exactly midnight is the start of a day, so it yields
 * a whole day, never zero.
 */
export function msUntilNextUtcMidnight(now: Date = new Date()): number {
  const dayStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return dayStart + DAY_MS - now.getTime();
}

/**
 * Resolve a daily write limit from a (possibly string) environment value,
 * falling back to `fallback` when the value is missing or not a positive
 * integer. Thin wrapper over `resolvePositiveInt` so the coercion rules for
 * numeric env vars live in one place; callers that want to log a bad value
 * should use `resolvePositiveInt` directly.
 */
export function resolveDailyWriteLimit(raw: unknown, fallback: number): number {
  return resolvePositiveInt(raw, fallback).value;
}

export class DailyWriteLimiter {
  private readonly logger = new Logger(DailyWriteLimiter.name);

  constructor(
    private readonly counters: AuthAttemptCounterService,
    private readonly scope: string,
    private readonly dailyLimit: number,
  ) {}

  /**
   * Check whether a user has remaining write quota for today. A failure to
   * read the count rejects, so the caller refuses before writing.
   */
  async checkLimit(userId: string): Promise<{
    allowed: boolean;
    currentCount: number;
    limit: number;
  }> {
    const currentCount = await this.counters.peek(this.scope, userId);
    return {
      allowed: currentCount < this.dailyLimit,
      currentCount,
      limit: this.dailyLimit,
    };
  }

  /**
   * Count `count` writes that have already been made.
   *
   * Called after the write has committed, so it never rejects: a counter the
   * database could not update must not turn a write the user now has into an
   * error the caller (or a model) would retry into a duplicate. The failure is
   * logged and the day's count is short by what was lost -- the soft-guardrail
   * trade this limiter has always made. `tool` names the operation in that log.
   *
   * One increment per unit, sequentially: the counter adds one per statement,
   * and each statement takes its own short-lived connection.
   */
  async record(userId: string, tool: string, count = 1): Promise<void> {
    try {
      for (let i = 0; i < count; i++) {
        await this.counters.increment(
          this.scope,
          userId,
          msUntilNextUtcMidnight(),
          "fixed",
        );
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Could not count ${tool} against the ${this.scope} daily limit: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
