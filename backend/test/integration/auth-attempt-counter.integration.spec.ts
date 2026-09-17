import { DataSource } from "typeorm";

import { AuthAttemptCounterService } from "@/auth/auth-attempt-counter.service";
import { withSystemContext } from "@/common/db/with-context";

import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * The counter's atomicity is a property of PostgreSQL, not of the service.
 *
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING count` is the whole limiter:
 * the second writer blocks on the first's row lock, then re-evaluates the
 * `CASE` against the row the first committed. A mocked manager can be told to
 * return 1 and 2 and would prove nothing about that, so the concurrent calls
 * here are on **two separate connections** (VER-001,
 * `docs/verification-contract.md`).
 *
 * The window arithmetic gets the same treatment, because the reason it moved
 * off a process clock is that two replicas' clocks differ: every comparison
 * below is made by the database against rows it stamped itself.
 */
describe("AuthAttemptCounterService (real PostgreSQL)", () => {
  let dataSourceA: DataSource;
  let dataSourceB: DataSource;
  let serviceA: AuthAttemptCounterService;
  let serviceB: AuthAttemptCounterService;

  const SCOPE = "2fa-user";
  const KEY = "22222222-2222-4222-8222-222222222222";
  const WINDOW_MS = 5 * 60 * 1000;

  beforeAll(async () => {
    dataSourceA = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceA.initialize();
    await applyRlsPolicies(dataSourceA);
    // A second DataSource is a second pool, so the two services below cannot
    // share a connection however the pool happens to hand them out. That is the
    // point: one process holding two handles is the closest a single test
    // process gets to two replicas.
    dataSourceB = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceB.initialize();

    serviceA = new AuthAttemptCounterService(dataSourceA);
    serviceB = new AuthAttemptCounterService(dataSourceB);
  });

  afterAll(async () => {
    if (dataSourceA?.isInitialized) await dataSourceA.destroy();
    if (dataSourceB?.isInitialized) await dataSourceB.destroy();
  });

  beforeEach(async () => {
    await dataSourceA.query("DELETE FROM auth_attempt_counters");
  });

  it("serializes two concurrent increments of one key", async () => {
    const [first, second] = await withSystemContext(() =>
      Promise.all([
        serviceA.increment(SCOPE, KEY, WINDOW_MS),
        serviceB.increment(SCOPE, KEY, WINDOW_MS),
      ]),
    );

    // Neither replica sees the same number. If the statement were a read
    // followed by a write, both would return 1 and the limiter would count half
    // the attempts it was given.
    expect([first.count, second.count].sort()).toEqual([1, 2]);

    const rows: { count: number }[] = await dataSourceA.query(
      "SELECT count FROM auth_attempt_counters WHERE scope = $1 AND key = $2",
      [SCOPE, KEY],
    );
    expect(Number(rows[0].count)).toBe(2);
  });

  it("restarts the count once the window has passed, without deleting the row", async () => {
    await withSystemContext(() => serviceA.increment(SCOPE, KEY, WINDOW_MS));
    await withSystemContext(() => serviceB.increment(SCOPE, KEY, WINDOW_MS));

    // Age the row rather than wait: what the statement reads is
    // `window_expires_at`, so moving it into the past is exactly the state a
    // lapsed window leaves behind.
    await dataSourceA.query(
      `UPDATE auth_attempt_counters
          SET window_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE scope = $1 AND key = $2`,
      [SCOPE, KEY],
    );

    const afterExpiry = await withSystemContext(() =>
      serviceA.increment(SCOPE, KEY, WINDOW_MS),
    );

    expect(afterExpiry.count).toBe(1);
    expect(afterExpiry.windowExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("reads and clears the count another connection wrote", async () => {
    await withSystemContext(() => serviceA.increment(SCOPE, KEY, WINDOW_MS));

    // The reason the table exists: B never incremented anything.
    await expect(
      withSystemContext(() => serviceB.peek(SCOPE, KEY)),
    ).resolves.toBe(1);

    await withSystemContext(() => serviceB.reset(SCOPE, KEY));
    await expect(
      withSystemContext(() => serviceA.peek(SCOPE, KEY)),
    ).resolves.toBe(0);
  });

  it("reports an expired window as zero without a sweep having run", async () => {
    await withSystemContext(() => serviceA.increment(SCOPE, KEY, WINDOW_MS));
    await dataSourceA.query(
      `UPDATE auth_attempt_counters
          SET window_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE scope = $1 AND key = $2`,
      [SCOPE, KEY],
    );

    // The row is still there -- the sweep is garbage collection, never part of
    // the limit.
    const rows: unknown[] = await dataSourceA.query(
      "SELECT 1 FROM auth_attempt_counters WHERE scope = $1 AND key = $2",
      [SCOPE, KEY],
    );
    expect(rows).toHaveLength(1);
    await expect(
      withSystemContext(() => serviceA.peek(SCOPE, KEY)),
    ).resolves.toBe(0);
  });
});
