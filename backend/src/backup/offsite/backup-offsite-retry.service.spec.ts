import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import type { AutoBackupService } from "../auto-backup.service";
import type { BackupOffsiteDispatchService } from "./backup-offsite-dispatch.service";
import { MAX_OFFSITE_ATTEMPTS } from "./backup-offsite-dispatch.service";
import { BackupOffsiteRetryService } from "./backup-offsite-retry.service";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

/**
 * The hourly re-attempt of off-machine copies that failed (WP6 of
 * `docs/future-plans/backup-off-machine.md`).
 *
 * What this suite can prove and what it cannot is worth stating, because the
 * difference is the reason there is an integration spec beside it. It proves the
 * sweep's *shape*: which rows it asks for, that each one is re-attempted under
 * its own owner through the one shared claim, and that a row that blows up takes
 * only itself down. It cannot prove the backoff arithmetic or the single-winner
 * claim -- both are properties of PostgreSQL, and a mocked `query` would record
 * the string and resolve (`docs/verification-contract.md`).
 * `test/integration/backup-offsite-claim.integration.spec.ts` owns those.
 */

const USER_A = "33333333-3333-4333-8333-333333333333";
const USER_B = "44444444-4444-4444-8444-444444444444";
const DIGEST = "b".repeat(64);

/** One row as the driver hands it back: snake_case, BIGINT as a string. */
const dueRow = (overrides: Record<string, unknown> = {}) => ({
  id: "row-1",
  user_id: USER_A,
  destination: "s3",
  object_key: `33/33/${USER_A}/monize-backup-daily-2026-09-14-${DIGEST.slice(0, 12)}.mzbe`,
  tier: "daily",
  digest: DIGEST,
  size_bytes: "4096",
  ...overrides,
});

describe("BackupOffsiteRetryService", () => {
  let query: jest.Mock;
  let service: BackupOffsiteRetryService;
  let claimAndPerform: jest.MockedFunction<
    BackupOffsiteDispatchService["claimAndPerform"]
  >;
  let resolveStoredBackupFolder: jest.MockedFunction<
    AutoBackupService["resolveStoredBackupFolder"]
  >;

  beforeEach(() => {
    const scoped = createScopedDbMocks();
    query = scoped.manager.query;
    query.mockResolvedValue([]);
    claimAndPerform = jest.fn().mockResolvedValue(true) as never;
    resolveStoredBackupFolder = jest
      .fn()
      .mockImplementation(
        async (userId: string) => `/data/backups/${userId}`,
      ) as never;

    service = new BackupOffsiteRetryService(
      scoped.dataSource as never,
      { claimAndPerform } as never,
      { resolveStoredBackupFolder } as never,
    );
  });

  afterEach(() => jest.clearAllMocks());

  describe("which rows it asks for", () => {
    it("selects failed copies under the attempt ceiling whose backoff has elapsed", async () => {
      await service.handleRetrySweep();

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain("FROM backup_offsite_uploads");
      expect(sql).toContain("status = 'failed'");
      expect(sql).toContain("attempts < $1");
      // Doubling from one hour: 1, 2, 4, 8. Asserted as the statement, because
      // the arithmetic is the database's -- the integration spec evaluates it.
      expect(sql).toContain(
        "INTERVAL '1 hour' * power(2, GREATEST(attempts - 1, 0))",
      );
      expect(sql).toContain("ORDER BY updated_at ASC");
      expect(params[0]).toBe(MAX_OFFSITE_ATTEMPTS);
      expect(params[1]).toBeGreaterThan(0);
    });

    it("does nothing when nothing is due", async () => {
      await service.handleRetrySweep();

      expect(resolveStoredBackupFolder).not.toHaveBeenCalled();
      expect(claimAndPerform).not.toHaveBeenCalled();
    });

    it("survives a sweep whose own query fails", async () => {
      query.mockRejectedValue(new Error("db down"));

      await expect(service.handleRetrySweep()).resolves.toBeUndefined();
      expect(claimAndPerform).not.toHaveBeenCalled();
    });
  });

  describe("what it does with each row", () => {
    it("re-attempts the same bytes under the same key, through the shared claim", async () => {
      query.mockResolvedValue([dueRow()]);

      await service.handleRetrySweep();

      expect(claimAndPerform).toHaveBeenCalledTimes(1);
      expect(claimAndPerform).toHaveBeenCalledWith({
        userId: USER_A,
        destination: "s3",
        objectKey: dueRow().object_key,
        tier: "daily",
        digest: DIGEST,
        // BIGINT arrives as a string and is compared numerically downstream.
        sizeBytes: 4096,
        folder: `/data/backups/${USER_A}`,
        // Derived from the key: the row describes a copy, not a run.
        filename: "monize-backup-daily-2026-09-14.mzbe",
        origin: "automatic",
      });
    });

    it("reads the artifact from the user's current folder, not a remembered one", async () => {
      query.mockResolvedValue([dueRow()]);
      resolveStoredBackupFolder.mockResolvedValue("/mnt/moved/33/33/user");

      await service.handleRetrySweep();

      expect(resolveStoredBackupFolder).toHaveBeenCalledWith(USER_A);
      expect(claimAndPerform.mock.calls[0][0].folder).toBe(
        "/mnt/moved/33/33/user",
      );
    });

    it("takes the email destination's key as the filename unchanged", async () => {
      query.mockResolvedValue([
        dueRow({
          destination: "email",
          object_key: "monize-backup-weekly-2026-09-14.mzbe",
          tier: "weekly",
        }),
      ]);

      await service.handleRetrySweep();

      expect(claimAndPerform.mock.calls[0][0]).toMatchObject({
        destination: "email",
        filename: "monize-backup-weekly-2026-09-14.mzbe",
        tier: "weekly",
      });
    });
  });

  describe("one row's failure is one row's failure", () => {
    it("carries on after a folder that cannot be resolved", async () => {
      query.mockResolvedValue([
        dueRow({ id: "row-1", user_id: USER_A }),
        dueRow({ id: "row-2", user_id: USER_B }),
      ]);
      resolveStoredBackupFolder.mockImplementation(async (userId: string) => {
        if (userId === USER_A) throw new Error("folder outside allowed roots");
        return `/data/backups/${userId}`;
      });

      await expect(service.handleRetrySweep()).resolves.toBeUndefined();

      expect(claimAndPerform).toHaveBeenCalledTimes(1);
      expect(claimAndPerform.mock.calls[0][0].userId).toBe(USER_B);
    });

    it("carries on after a re-attempt that throws", async () => {
      query.mockResolvedValue([
        dueRow({ id: "row-1", user_id: USER_A }),
        dueRow({ id: "row-2", user_id: USER_B }),
      ]);
      claimAndPerform.mockRejectedValueOnce(new Error("pool exhausted"));

      await expect(service.handleRetrySweep()).resolves.toBeUndefined();

      expect(claimAndPerform).toHaveBeenCalledTimes(2);
    });
  });
});
