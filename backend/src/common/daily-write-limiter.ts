/**
 * Per-user daily write limiter shared by the surfaces that let an LLM mutate
 * a user's financial data (the MCP server tools and the AI Assistant action
 * confirmation endpoint). It caps how many write operations a single user can
 * perform in a UTC day so a misbehaving model -- or a user spamming
 * confirmations -- cannot make an unbounded number of modifications.
 *
 * The store is in-memory: it resets on process restart and is not shared
 * across instances. That is an intentional, low-cost guardrail consistent with
 * the existing MCP limiter, not a hard security boundary.
 */

import { resolvePositiveInt } from "./env-number.util";

export interface WriteOperation {
  userId: string;
  tool: string;
  timestamp: number;
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
  private readonly operations: WriteOperation[] = [];

  constructor(private readonly dailyLimit: number) {}

  /**
   * Check whether a user has remaining write quota for today.
   * Returns { allowed: true } if under the limit, or { allowed: false }
   * with the current count and limit if exceeded.
   */
  checkLimit(userId: string): {
    allowed: boolean;
    currentCount: number;
    limit: number;
  } {
    this.pruneExpired();
    const dayStart = this.getDayStart();
    const currentCount = this.operations.filter(
      (op) => op.userId === userId && op.timestamp >= dayStart,
    ).length;

    return {
      allowed: currentCount < this.dailyLimit,
      currentCount,
      limit: this.dailyLimit,
    };
  }

  /**
   * Record a write operation for rate limiting purposes.
   */
  record(userId: string, tool: string): void {
    this.operations.push({
      userId,
      tool,
      timestamp: Date.now(),
    });
  }

  /**
   * Remove operations older than 24 hours to prevent unbounded memory growth.
   */
  private pruneExpired(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let i = 0;
    while (
      i < this.operations.length &&
      this.operations[i].timestamp < cutoff
    ) {
      i++;
    }
    if (i > 0) {
      this.operations.splice(0, i);
    }
  }

  /**
   * Get the start of the current UTC day in milliseconds.
   */
  private getDayStart(): number {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
}
