import { getRequestContext } from "../common/request-context";

/**
 * One portfolio valuation per user, scope and minute.
 *
 * Opening the Investments page issues three requests that each need the same
 * valuation -- `GET /portfolio/summary`, `GET /portfolio/allocation/by-tag` and
 * (until this change) `GET /portfolio/tag-keys` -- and they start together, so
 * the server priced the same holdings three times concurrently. The valuation
 * is expensive for a reason that is not going away: live FX priming, a
 * per-holding cost-basis replay, and a day-by-day since-inception result.
 *
 * This memo holds the *in-flight promise*, not only the settled value, which is
 * what makes concurrent callers share one computation rather than three. A
 * rejection is never cached: the entry is dropped so the next caller recomputes
 * instead of inheriting a failure for a minute.
 *
 * It is process memory, deliberately, and the same bargain the intraday cache
 * next door already makes: with more than one replica, a write served by pod A
 * leaves pod B able to answer from its own memo for up to
 * {@link PORTFOLIO_SUMMARY_MEMO_TTL_MS} afterwards. Invalidation is therefore a
 * latency optimisation on the writing pod, not a distributed guarantee;
 * `docs/backend/securities-and-providers.md` states that explicitly.
 */

/** Same 60 s window the intraday price cache uses. */
export const PORTFOLIO_SUMMARY_MEMO_TTL_MS = 60_000;

/**
 * Bound on live entries. A key is per user, account scope and currency, so a
 * busy multi-tenant pod can accumulate them; the oldest is evicted first
 * (insertion order, which `Map` preserves).
 */
export const PORTFOLIO_SUMMARY_MEMO_MAX_ENTRIES = 256;

interface MemoEntry {
  /** The user the entry belongs to, so invalidation can find it by owner. */
  readonly userId: string;
  /**
   * When the settled value stops being served, or `null` while the computation
   * is still in flight.
   *
   * The TTL runs from the moment the value exists, not from the moment the
   * work started: a valuation that takes 48 s used to leave 12 s of a 60 s
   * entry, so the next page open paid for the whole walk again (issue #1409).
   * An in-flight entry has no expiry at all, which is what lets every caller
   * that arrives during a long computation share it rather than starting a
   * second one beside it.
   */
  expiresAt: number | null;
  /** In flight or settled -- a shared promise is what de-duplicates callers. */
  readonly value: Promise<unknown>;
}

/** Whether an entry has stopped being servable. In flight is never expired. */
function isExpired(entry: MemoEntry, now: number): boolean {
  return entry.expiresAt !== null && entry.expiresAt <= now;
}

/**
 * The memo key.
 *
 * Every input that can change the answer is part of the key rather than a
 * reason to bypass the memo: the reporting currency (a display currency that is
 * not the preference produces a different summary), the account scope, and the
 * ambient identity. The last one matters because a delegate acting on an
 * owner's accounts reads under the delegate's RLS identity: the answer it
 * computes is not necessarily the answer the owner's own request would compute,
 * so the two must not share an entry.
 */
export function buildPortfolioSummaryMemoKey(
  userId: string,
  accountIds: string[] | undefined,
  reportingCurrency: string,
): string {
  const scope =
    accountIds && accountIds.length > 0
      ? [...accountIds].sort().join(",")
      : "all";
  const ctx = getRequestContext();
  const identity = ctx?.system
    ? "system"
    : `${ctx?.userId ?? "-"}:${ctx?.realUserId ?? "-"}`;
  return `${userId}|${scope}|${reportingCurrency}|${identity}`;
}

class PortfolioSummaryMemo {
  private readonly entries = new Map<string, MemoEntry>();

  /**
   * Return the entry for `key`, or start `compute` and share its promise with
   * every caller that arrives while it runs.
   */
  run<T>(userId: string, key: string, compute: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && !isExpired(existing, now)) {
      return existing.value as Promise<T>;
    }

    const value = compute();
    const entry: MemoEntry = { userId, expiresAt: null, value };
    this.entries.set(key, entry);
    // The TTL starts when the answer exists. Setting it at the start of the
    // computation charged the wait against the entry's own life: a 48 s
    // valuation was servable for 12 s, so the walk ran again a minute later
    // whether or not anything had changed.
    value.then(
      () => {
        // Only while this entry is still the one being served: an invalidation
        // during the computation dropped it deliberately, and dating a
        // replacement here would put the stale answer back.
        if (this.entries.get(key) === entry) {
          entry.expiresAt = Date.now() + PORTFOLIO_SUMMARY_MEMO_TTL_MS;
        }
      },
      // A failed valuation is not an answer, so it is not remembered. This
      // only removes the entry; the rejection itself still reaches every
      // awaiting caller through the returned promise.
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    this.evictExpired(now);
    return value;
  }

  /** Drop every entry belonging to one user. */
  invalidateUser(userId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.userId === userId) this.entries.delete(key);
    }
  }

  /** Drop everything (whole-dataset events, and test isolation). */
  clearAll(): void {
    this.entries.clear();
  }

  /** Live entry count -- for the specs that assert the bound. */
  get size(): number {
    return this.entries.size;
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (isExpired(entry, now)) this.entries.delete(key);
    }
    // Insertion order: the oldest key goes first once the bound is exceeded.
    // An in-flight entry is evictable here (it has no expiry to reach): every
    // caller already awaiting it still gets its promise, and a caller arriving
    // afterwards starts a fresh computation rather than a full map being able
    // to hold the bound open.
    while (this.entries.size > PORTFOLIO_SUMMARY_MEMO_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * The process-wide memo. A module-level singleton rather than a provider so the
 * write paths that must invalidate it (price writes, the post-commit balance
 * seam, restore, demo reset, undo/redo) can call one function without taking a
 * constructor dependency on the securities module.
 */
export const portfolioSummaryMemo = new PortfolioSummaryMemo();

/**
 * Forget a user's memoized valuations.
 *
 * Called from every seam that makes one untrue: a price write, the post-commit
 * balance invalidation (INV-CACHE-001), a restore, a demo reset, an undo or a
 * redo.
 */
export function invalidatePortfolioSummary(userId: string): void {
  portfolioSummaryMemo.invalidateUser(userId);
}

/** Forget every user's valuations: whole-dataset writes with no single owner. */
export function invalidateAllPortfolioSummaries(): void {
  portfolioSummaryMemo.clearAll();
}
