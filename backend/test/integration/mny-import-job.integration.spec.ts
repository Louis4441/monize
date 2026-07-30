import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

import { ImportJob } from "@/import/mny/entities/import-job.entity";
import { ImportStagedFile } from "@/import/mny/entities/import-staged-file.entity";
import {
  JOB_STALLED_ERROR_KEY,
  MnyImportJobService,
} from "@/import/mny/mny-import-job.service";
import { MnyStagingService } from "@/import/mny/mny-staging.service";
import { MnyPasswordIncorrectError } from "@/import/mny/mny-errors";
import { DEFAULT_MNY_IMPORT_OPTIONS } from "@/import/mny/model/mny-import-options";
import { MnyImportResult } from "@/import/mny/model/mny-import-job";
import { withUserContext } from "@/common/db/with-context";
import { withScopedDb } from "@/common/db/scoped-db";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * Job concurrency against a real database, because the two properties that
 * matter are properties of Postgres, not of the service: the conditional UPDATE
 * that makes a claim atomic, and the interval arithmetic the reaper depends on.
 */
describe("MnyImportJobService (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let jobs: MnyImportJobService;
  let staging: MnyStagingService;
  let userA: string;
  let userB: string;

  const EMPTY_RESULT: MnyImportResult = {
    accountsCreated: 0,
    payeesCreated: 0,
    categoriesCreated: 0,
    transactionsCreated: 0,
    splitsCreated: 0,
    transfersLinked: 0,
    securitiesCreated: 0,
    investmentTransactionsCreated: 0,
    pricesImported: 0,
    exchangeRatesImported: 0,
    billsCreated: 0,
    skipped: { accounts: 0, payees: 0, categories: 0, transactions: 0, bills: 0 },
    existingDataRemoved: false,
    verification: [],
    holdings: [],
    warnings: [],
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot(INTEGRATION_TYPEORM_OPTIONS),
        TypeOrmModule.forFeature([ImportJob, ImportStagedFile]),
      ],
      providers: [MnyImportJobService, MnyStagingService],
    }).compile();

    dataSource = module.get(DataSource);
    jobs = module.get(MnyImportJobService);
    staging = module.get(MnyStagingService);

    userA = (await createTestUserDirect(dataSource)).id;
    userB = (await createTestUserDirect(dataSource)).id;
  });

  afterAll(async () => {
    await module?.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, ["import_jobs", "import_staged_files"]);
  });

  const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
    withUserContext(userId, fn);

  async function newJob(userId = userA): Promise<string> {
    const staged = await asUser(userId, () =>
      staging.stage(userId, {
        filename: "money.mny",
        data: Buffer.from("bytes"),
      }),
    );
    const job = await asUser(userId, () =>
      jobs.create(userId, staged.id, DEFAULT_MNY_IMPORT_OPTIONS),
    );
    return job.id;
  }

  describe("create", () => {
    it("starts pending with the options it was given", async () => {
      const jobId = await newJob();
      const job = await asUser(userA, () => jobs.findOne(userA, jobId));

      expect(job).toMatchObject({ status: "pending", retryable: false });
      expect(job!.options.referencedOnlyPayees).toBe(true);
      expect(job!.startedAt).toBeNull();
    });

    it("is not visible to another user", async () => {
      const jobId = await newJob();

      expect(await asUser(userB, () => jobs.findOne(userB, jobId))).toBeNull();
    });
  });

  describe("claim", () => {
    it("has exactly one winner when two workers race", async () => {
      const jobId = await newJob();

      const outcomes = await Promise.all([
        asUser(userA, () => jobs.claim(jobId)),
        asUser(userA, () => jobs.claim(jobId)),
      ]);

      expect(outcomes.filter(Boolean)).toHaveLength(1);
    });

    it("has one winner across four concurrent workers", async () => {
      const jobId = await newJob();

      const outcomes = await Promise.all(
        Array.from({ length: 4 }, () => asUser(userA, () => jobs.claim(jobId))),
      );

      expect(outcomes.filter(Boolean)).toHaveLength(1);
    });

    it("stamps the row running with a heartbeat", async () => {
      const jobId = await newJob();
      await asUser(userA, () => jobs.claim(jobId));

      const job = await asUser(userA, () => jobs.findOne(userA, jobId));
      expect(job!.status).toBe("running");
      expect(job!.startedAt).not.toBeNull();
      expect(job!.heartbeatAt).not.toBeNull();
    });

    it("refuses a job that already completed", async () => {
      const jobId = await newJob();
      await asUser(userA, () => jobs.claim(jobId));
      await asUser(userA, () => jobs.complete(jobId, EMPTY_RESULT));

      expect(await asUser(userA, () => jobs.claim(jobId))).toBe(false);
    });
  });

  describe("progress", () => {
    it("is visible to a reader while the import transaction is still open", async () => {
      // The reason runOutsideActiveScopedManager exists: a progress write inside
      // the import's transaction would be invisible until commit.
      const jobId = await newJob();
      await asUser(userA, () => jobs.claim(jobId));

      await asUser(userA, () =>
        withScopedDb(dataSource, async () => {
          await jobs.reportProgress(jobId, {
            phase: "transactions",
            processed: 250,
            total: 1000,
          });

          const seenByPoller = await dataSource
            .getRepository(ImportJob)
            .findOne({ where: { id: jobId } });
          expect(seenByPoller!.progress).toEqual({
            phase: "transactions",
            processed: 250,
            total: 1000,
          });
        }),
      );
    });

    it("is ignored once the job is no longer running", async () => {
      const jobId = await newJob();

      await asUser(userA, () =>
        jobs.reportProgress(jobId, {
          phase: "preparing",
          processed: 0,
          total: 0,
        }),
      );

      const job = await asUser(userA, () => jobs.findOne(userA, jobId));
      expect(job!.progress).toBeNull();
    });
  });

  describe("runClaimed", () => {
    it("completes with the body's result and clears progress", async () => {
      const jobId = await newJob();

      const ran = await asUser(userA, () =>
        jobs.runClaimed(userA, jobId, async (context) => {
          await context.reportProgress({
            phase: "reference",
            processed: 1,
            total: 2,
          });
          return { ...EMPTY_RESULT, transactionsCreated: 7 };
        }),
      );

      const job = await asUser(userA, () => jobs.findOne(userA, jobId));
      expect(ran).toBe(true);
      expect(job!.status).toBe("completed");
      expect(job!.result!.transactionsCreated).toBe(7);
      expect(job!.progress).toBeNull();
      expect(job!.completedAt).not.toBeNull();
    });

    it("does not run the body when another worker holds the job", async () => {
      const jobId = await newJob();
      await asUser(userA, () => jobs.claim(jobId));
      const body = jest.fn();

      const ran = await asUser(userA, () =>
        jobs.runClaimed(userA, jobId, body as never),
      );

      expect(ran).toBe(false);
      expect(body).not.toHaveBeenCalled();
    });

    it("marks a parse failure not retryable -- the same bytes cannot succeed", async () => {
      const jobId = await newJob();

      await asUser(userA, () =>
        jobs.runClaimed(userA, jobId, () => {
          throw new MnyPasswordIncorrectError();
        }),
      );

      const job = await asUser(userA, () => jobs.findOne(userA, jobId));
      expect(job!.status).toBe("failed");
      expect(job!.errorKey).toBe("mnyPasswordIncorrect");
      expect(job!.retryable).toBe(false);
    });

    it("marks any other failure retryable, since the staged file survives", async () => {
      const jobId = await newJob();

      await asUser(userA, () =>
        jobs.runClaimed(userA, jobId, () => {
          throw new Error("connection terminated");
        }),
      );

      const job = await asUser(userA, () => jobs.findOne(userA, jobId));
      expect(job).toMatchObject({
        status: "failed",
        errorKey: "mnyImportFailed",
        retryable: true,
        errorDetail: "connection terminated",
      });
      expect(job!.stagedFileId).not.toBeNull();
    });
  });

  describe("hasActiveJob", () => {
    it("is true for a pending job and false once it finished", async () => {
      const jobId = await newJob();
      expect(await asUser(userA, () => jobs.hasActiveJob(userA))).toBe(true);

      await asUser(userA, () => jobs.claim(jobId));
      expect(await asUser(userA, () => jobs.hasActiveJob(userA))).toBe(true);

      await asUser(userA, () => jobs.complete(jobId, EMPTY_RESULT));
      expect(await asUser(userA, () => jobs.hasActiveJob(userA))).toBe(false);
    });

    it("does not see another user's in-flight job", async () => {
      await newJob(userA);

      expect(await asUser(userB, () => jobs.hasActiveJob(userB))).toBe(false);
    });
  });

  describe("reapStaleJobs", () => {
    it("fails a running job whose heartbeat went stale, retryably", async () => {
      const jobId = await newJob();
      await asUser(userA, () => jobs.claim(jobId));
      await dataSource.query(
        "UPDATE import_jobs SET heartbeat_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes' WHERE id = $1",
        [jobId],
      );

      await jobs.reapStaleJobs();

      const job = await asUser(userA, () => jobs.findOne(userA, jobId));
      expect(job).toMatchObject({
        status: "failed",
        errorKey: JOB_STALLED_ERROR_KEY,
        retryable: true,
      });
      // Retry has to be one click, so the bytes must still be there.
      expect(job!.stagedFileId).not.toBeNull();
    });

    it("leaves a job whose heartbeat is recent alone", async () => {
      const jobId = await newJob();
      await asUser(userA, () => jobs.claim(jobId));

      await jobs.reapStaleJobs();

      const job = await asUser(userA, () => jobs.findOne(userA, jobId));
      expect(job!.status).toBe("running");
    });

    it("leaves a pending job alone -- it has no worker to lose", async () => {
      const jobId = await newJob();
      await dataSource.query(
        "UPDATE import_jobs SET heartbeat_at = CURRENT_TIMESTAMP - INTERVAL '1 day' WHERE id = $1",
        [jobId],
      );

      await jobs.reapStaleJobs();

      const job = await asUser(userA, () => jobs.findOne(userA, jobId));
      expect(job!.status).toBe("pending");
    });

    it("is idempotent: a second sweep changes nothing", async () => {
      const jobId = await newJob();
      await asUser(userA, () => jobs.claim(jobId));
      await dataSource.query(
        "UPDATE import_jobs SET heartbeat_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes' WHERE id = $1",
        [jobId],
      );

      await jobs.reapStaleJobs();
      const first = await asUser(userA, () => jobs.findOne(userA, jobId));
      await jobs.reapStaleJobs();
      const second = await asUser(userA, () => jobs.findOne(userA, jobId));

      expect(second!.completedAt).toEqual(first!.completedAt);
    });

    it("reaps across users, since it runs under a system context", async () => {
      const jobA = await newJob(userA);
      const jobB = await newJob(userB);
      await asUser(userA, () => jobs.claim(jobA));
      await asUser(userB, () => jobs.claim(jobB));
      await dataSource.query(
        "UPDATE import_jobs SET heartbeat_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes'",
      );

      await jobs.reapStaleJobs();

      expect(
        (await asUser(userA, () => jobs.findOne(userA, jobA)))!.status,
      ).toBe("failed");
      expect(
        (await asUser(userB, () => jobs.findOne(userB, jobB)))!.status,
      ).toBe("failed");
    });
  });
});
