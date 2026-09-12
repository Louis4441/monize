import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Test, TestingModule } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { DataSource } from "typeorm";
import { gunzipSync } from "zlib";

import { AccountsController } from "@/accounts/accounts.controller";
import { CalendarModule } from "@/calendar/calendar.module";
import { CalendarDayNotesController } from "@/calendar/calendar-day-notes.controller";
import { AccountDelegateGuard } from "@/delegation/guards/account-delegate.guard";
import { BackupService } from "@/backup/backup.service";
import { BackupExportService } from "@/backup/backup-export.service";
import { BackupRestoreService } from "@/backup/backup-restore.service";
import { BackupAttachmentTransferService } from "@/backup/backup-attachment-transfer.service";
import { BackupRestoreDatabaseService } from "@/backup/backup-restore-database.service";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { OidcReauthService } from "@/auth/oidc/oidc-reauth.service";
import { EncryptionService } from "@/common/encryption/encryption.service";
import { DatabaseStorageProvider } from "@/attachments/storage/database-storage.provider";
import { ATTACHMENT_STORAGE_PROVIDER } from "@/attachments/storage/attachment-storage.interface";
import { JobClaimService } from "@/common/jobs/job-claim.service";
import { UserMaintenanceService } from "@/common/jobs/user-maintenance.service";
import { User } from "@/users/entities/user.entity";
import { withUserContext } from "@/common/db/with-context";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
  INTEGRATION_TYPEORM_OPTIONS,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * The calendar's one write path against a real database (design section 6.4).
 *
 * Three properties need a live PostgreSQL and cannot be shown with a mocked
 * manager. The upsert is one statement over a unique constraint, so "the second
 * save is an update and not a second row" is a claim about
 * `uq_calendar_day_notes_user_date`, which only the database holds
 * (INV-DAYNOTE-001). The table is in the RLS **Direct** bucket with no delegate
 * arm, so "two users hold a note on the same date" is a claim about the policy,
 * not about the `WHERE user_id = $1` the service also writes. And the route's
 * refusal of an acting delegate is a claim about the absence of a decorator,
 * which only the real `Reflector` reading the real controller can answer -- the
 * guard's unit spec mocks exactly that answer.
 */
describe("Calendar day notes under RLS enforcement", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  /** The table owner: seeds and inspects. Never the connection under test. */
  let db: DataSource;
  let notes: CalendarDayNotesController;

  let aliceId: string;
  let bobId: string;
  let daveId: string;
  let delegationId: string;

  const DAY = "2024-06-14";

  function req(userId: string) {
    return {
      user: {
        id: userId,
        realUserId: userId,
        isActing: false,
        delegationId: null,
      },
    } as never;
  }

  async function rowsFor(
    userId: string,
  ): Promise<Array<{ note_date: string; body: string }>> {
    return db.query(
      `SELECT note_date::TEXT AS note_date, body FROM calendar_day_notes
        WHERE user_id = $1 ORDER BY note_date`,
      [userId],
    );
  }

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([CalendarModule]);
    module = harness.module;
    db = harness.owner;
    notes = module.get(CalendarDayNotesController);

    await cleanTables(db, [
      "calendar_day_notes",
      "account_delegate_grants",
      "account_delegates",
      "users",
    ]);
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
    daveId = (await createTestUserDirect(db, { firstName: "Dave" })).id;
    const [delegation] = await db.query(
      `INSERT INTO account_delegates (owner_user_id, delegate_user_id, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [aliceId, daveId],
    );
    delegationId = delegation.id;
  });

  afterAll(async () => {
    await harness.close();
  });

  it("reads, writes twice and deletes, leaving one row and then none", async () => {
    await withUserContext(aliceId, async () => {
      expect(
        await notes.list(req(aliceId), {
          startDate: "2024-06-01",
          endDate: "2024-06-30",
        }),
      ).toEqual([]);

      const created = await notes.upsert(req(aliceId), DAY, {
        body: "Dentist at 9",
      });
      expect(created.date).toBe(DAY);
      expect(created.body).toBe("Dentist at 9");

      const updated = await notes.upsert(req(aliceId), DAY, {
        body: "Dentist moved to 11",
      });
      expect(updated.date).toBe(DAY);
      expect(updated.body).toBe("Dentist moved to 11");
    });

    // The second save is an UPDATE, not an insert that happened to win: one
    // row, carrying the second body. A read-then-decide would have produced
    // either two rows or a unique-violation under concurrency.
    expect(await rowsFor(aliceId)).toEqual([
      { note_date: DAY, body: "Dentist moved to 11" },
    ]);

    await withUserContext(aliceId, async () => {
      const listed = await notes.list(req(aliceId), {
        startDate: "2024-06-01",
        endDate: "2024-06-30",
      });
      expect(listed.map((n) => n.body)).toEqual(["Dentist moved to 11"]);

      await notes.remove(req(aliceId), DAY);
      // Idempotent: the second delete is the caller asking for a state they
      // already have, not an error.
      await notes.remove(req(aliceId), DAY);
    });

    expect(await rowsFor(aliceId)).toEqual([]);
  });

  it("lets two users hold a note on the same date without collision", async () => {
    await withUserContext(aliceId, () =>
      notes.upsert(req(aliceId), DAY, { body: "Alice's day" }),
    );
    await withUserContext(bobId, () =>
      notes.upsert(req(bobId), DAY, { body: "Bob's day" }),
    );

    // The unique constraint is on (user_id, note_date), so the same date twice
    // is two rows -- and each user's list holds only their own, which under
    // enforcement is the policy's answer as much as the query's.
    expect(await rowsFor(aliceId)).toEqual([
      { note_date: DAY, body: "Alice's day" },
    ]);
    expect(await rowsFor(bobId)).toEqual([
      { note_date: DAY, body: "Bob's day" },
    ]);

    const alicesList = await withUserContext(aliceId, () =>
      notes.list(req(aliceId), {
        startDate: "2024-06-01",
        endDate: "2024-06-30",
      }),
    );
    expect(alicesList.map((n) => n.body)).toEqual(["Alice's day"]);
  });

  describe("an acting delegate is refused by the guard, not by the client", () => {
    const jwt = new JwtService({ secret: "calendar-day-notes-integration" });

    /**
     * The real guard with a real `Reflector`. Its collaborators are stubs
     * because this route never reaches them: the decorator is absent, so the
     * guard refuses before any grant is read. Were that to change, the stub
     * would throw rather than quietly answer, which is the failure this wants.
     */
    const guard = new AccountDelegateGuard(
      new Reflector(),
      jwt,
      {
        hasSection: () => {
          throw new Error("the guard must refuse before reading a section");
        },
      } as never,
      {
        isAccountOwnedBy: () => {
          throw new Error("the guard must refuse before reading an account");
        },
      } as never,
    );

    function contextFor(
      target: object,
      handler: (...args: never[]) => unknown,
    ): ExecutionContext {
      const token = jwt.sign({
        sub: daveId,
        email: "dave@example.com",
        actingAsUserId: aliceId,
        delegationId,
      });
      return {
        getType: () => "http",
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: `Bearer ${token}` },
          }),
        }),
        getHandler: () => handler,
        getClass: () => target,
      } as never;
    }

    it.each([
      ["list", CalendarDayNotesController.prototype.list],
      ["upsert", CalendarDayNotesController.prototype.upsert],
      ["remove", CalendarDayNotesController.prototype.remove],
    ])("refuses %s for a delegate acting as the owner", async (_name, fn) => {
      await expect(
        guard.canActivate(contextFor(CalendarDayNotesController, fn)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("still admits a route that IS marked for delegates", async () => {
      // The positive control. A guard that refused everything would pass the
      // three cases above while saying nothing about the controller's metadata.
      await expect(
        guard.canActivate(
          contextFor(
            AccountsController,
            AccountsController.prototype.getDailyBalanceTotals,
          ),
        ),
      ).resolves.toBe(true);
    });
  });
});

/**
 * A note survives the round trip that is the user's only way to move their data.
 *
 * Its own module because a restore is owner work: it truncates and re-inserts
 * across every table in `restore-plan.ts` under a maintenance lease, which is
 * the runtime role's job in production but not what this is about. What is
 * about: a new table reaches `export-table-queries.ts` and `restore-plan.ts` or
 * it silently does not travel, and nothing but a round trip notices.
 */
describe("Calendar day notes survive a backup round trip", () => {
  jest.setTimeout(180000);

  const PASSWORD = "TestPassword123!";
  let module: TestingModule;
  let backups: BackupService;
  let dataSource: DataSource;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot(INTEGRATION_TYPEORM_OPTIONS),
        TypeOrmModule.forFeature([User]),
      ],
      providers: [
        BackupService,
        BackupExportService,
        BackupRestoreService,
        BackupAttachmentTransferService,
        BackupRestoreDatabaseService,
        NetWorthService,
        OidcReauthService,
        JobClaimService,
        UserMaintenanceService,
        { provide: EncryptionService, useValue: { decrypt: () => "" } },
        DatabaseStorageProvider,
        {
          provide: ATTACHMENT_STORAGE_PROVIDER,
          useExisting: DatabaseStorageProvider,
        },
      ],
    }).compile();

    backups = module.get(BackupService);
    dataSource = module.get(DataSource);
    // The updated_at triggers the restore's timestamp preservation rides on.
    await applyRlsPolicies(dataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  it("carries the note into the archive and back out into another user", async () => {
    const source = await createTestUserDirect(dataSource, {
      firstName: "Source",
    });
    const target = await createTestUserDirect(dataSource, {
      firstName: "Target",
    });
    await dataSource.query(
      `INSERT INTO calendar_day_notes (user_id, note_date, body)
       VALUES ($1, DATE '2024-06-14', 'Quarterly review')`,
      [source.id],
    );

    const { buffer } = await withUserContext(source.id, () =>
      backups.exportToBuffer(source.id),
    );
    const parsed = JSON.parse(gunzipSync(buffer).toString("utf-8"));
    expect(parsed.calendar_day_notes).toHaveLength(1);
    expect(parsed.calendar_day_notes[0].body).toBe("Quarterly review");

    const result = await withUserContext(target.id, () =>
      backups.restoreData(target.id, {
        compressedData: buffer,
        password: PASSWORD,
      }),
    );
    expect(result.restored.calendarDayNotes).toBe(1);

    const restored = await dataSource.query(
      `SELECT note_date::TEXT AS note_date, body, user_id
         FROM calendar_day_notes WHERE user_id = $1`,
      [target.id],
    );
    // Re-scoped to the restoring user, which is what `scopeToUser` means: the
    // note is the target's now, not a row still pointing at its author.
    expect(restored).toEqual([
      {
        note_date: "2024-06-14",
        body: "Quarterly review",
        user_id: target.id,
      },
    ]);
  });
});
