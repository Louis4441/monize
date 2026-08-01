type CacheEntry<T> = {
  data: T;
  timestamp: number;
  ttl: number;
};

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const DEFAULT_TTL = 30_000; // 30 seconds

export function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > entry.ttl) {
    cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

export function setCache<T>(key: string, data: T, ttl: number = DEFAULT_TTL): void {
  cache.set(key, { data, timestamp: Date.now(), ttl });
}

export function invalidateCache(keyPrefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(keyPrefix)) {
      cache.delete(key);
    }
  }
}

export function clearAllCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Drop every cached view of a balance. Call this from any write that moves
 * money -- posting a scheduled transaction, editing a split, an investment
 * trade, an import -- not just the ones that go through `transactionsApi`.
 *
 * `accountsApi.getAll` caches for two minutes and the backend computes the
 * balance live from transactions, so a write that skips this leaves the
 * Accounts page showing the pre-write number until the entry ages out or the
 * browser reloads. Navigating back to the page does not help: the page
 * refetches on mount and the refetch is served from this cache.
 *
 * Both prefixes go together because an account balance and a portfolio value
 * are two views of the same rows: a trade moves the INVESTMENT_CASH balance,
 * and a split transfer moves an account the parent transaction never named.
 */
export function invalidateBalanceCaches(): void {
  invalidateCache('accounts:');
  invalidateCache('investments:');
}

// Cache + in-flight deduplication. When several callers request the same key
// before the first response arrives, they all await the same promise instead
// of triggering parallel network requests. Successful responses are cached
// for `ttl` ms; failures are not cached and propagate to every awaiter.
export function dedupe<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number = DEFAULT_TTL,
): Promise<T> {
  const cached = getCached<T>(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fetcher()
    .then((data) => {
      setCache(key, data, ttl);
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}
