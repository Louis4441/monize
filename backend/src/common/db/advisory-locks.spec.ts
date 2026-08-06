import {
  DB_LIFECYCLE_LOCK_KEY,
  DB_LIFECYCLE_LOCK_TIMEOUT,
  acquireDbLifecycleLock,
} from "./advisory-locks";

function makeClient(
  onQuery?: (text: string, params?: unknown[]) => Promise<unknown>,
) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: jest.fn((text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return onQuery ? onQuery(text, params) : Promise.resolve({ rows: [] });
    }),
  };
  return { client, calls };
}

describe("acquireDbLifecycleLock", () => {
  it("takes the advisory lock with the lifecycle key, parameterized", async () => {
    const { client, calls } = makeClient();
    const log = jest.fn();

    await acquireDbLifecycleLock(client, log);

    expect(calls.map((c) => c.text)).toEqual([
      "SELECT set_config('lock_timeout', $1, false)",
      "SELECT pg_advisory_lock($1)",
      "RESET lock_timeout",
    ]);
    expect(calls[1].params).toEqual([DB_LIFECYCLE_LOCK_KEY]);
  });

  it("says it is waiting before it blocks, and reports the acquisition", async () => {
    // The waiting line is the only signal an operator gets while a follower
    // sits behind a slow winner; logged after the blocking call, it would
    // appear exactly when it stopped being true.
    const order: string[] = [];
    const { client } = makeClient((text) => {
      if (text.includes("pg_advisory_lock")) order.push("lock");
      return Promise.resolve({ rows: [] });
    });
    const log = jest.fn((message: string) => {
      order.push(message.startsWith("Waiting") ? "waiting" : "acquired");
    });

    await acquireDbLifecycleLock(client, log);

    expect(order).toEqual(["waiting", "lock", "acquired"]);
  });

  it("bounds the wait, and restores the session's lock_timeout after acquiring", async () => {
    // The timeout protects the acquisition only. Left in place, it would apply
    // to every later lock wait on this session -- a migration's own DDL locks
    // -- and time out work that is merely slow.
    const { client, calls } = makeClient();

    await acquireDbLifecycleLock(client, jest.fn());

    expect(calls[0].params).toEqual([DB_LIFECYCLE_LOCK_TIMEOUT]);
    const lockAt = calls.findIndex((c) => c.text.includes("pg_advisory_lock"));
    const resetAt = calls.findIndex((c) => c.text === "RESET lock_timeout");
    expect(lockAt).toBeGreaterThan(-1);
    expect(resetAt).toBeGreaterThan(lockAt);
  });

  it("turns a lock timeout into an error naming the lock and the next step", async () => {
    // 55P03 lock_not_available: a wedged holder. Without the timeout the
    // symptom is a startup that hangs forever with nothing in the log but the
    // waiting line; with it, a named failure a restart loop retries.
    const { client } = makeClient((text) => {
      if (text.includes("pg_advisory_lock")) {
        return Promise.reject(
          Object.assign(new Error("canceling statement due to lock timeout"), {
            code: "55P03",
          }),
        );
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(acquireDbLifecycleLock(client, jest.fn())).rejects.toThrow(
      new RegExp(
        `within ${DB_LIFECYCLE_LOCK_TIMEOUT}[\\s\\S]*pg_locks[\\s\\S]*${DB_LIFECYCLE_LOCK_KEY}`,
      ),
    );
  });

  it("rethrows any other acquisition failure unchanged", async () => {
    // Only the timeout gets the friendly wrapper; a connection death or a
    // syntax problem must keep its own diagnosis.
    const { client } = makeClient((text) =>
      text.includes("pg_advisory_lock")
        ? Promise.reject(new Error("server closed the connection"))
        : Promise.resolve({ rows: [] }),
    );

    await expect(acquireDbLifecycleLock(client, jest.fn())).rejects.toThrow(
      "server closed the connection",
    );
  });

  it("keeps the key a literal constant", () => {
    // Advisory lock keys share one namespace per database; the key only has to
    // be unique and STABLE. Derived (hashtext, string seed) it could shift
    // between versions, and a key that shifts is a lock nobody is holding.
    expect(DB_LIFECYCLE_LOCK_KEY).toBe(4150293001);
  });
});
