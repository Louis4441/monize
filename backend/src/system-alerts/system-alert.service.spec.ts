import { Logger } from "@nestjs/common";
import {
  DEDUPE_KEY_MAX_LENGTH,
  SystemAlertService,
  SystemAlertInput,
} from "./system-alert.service";
import {
  AlertSeverity,
  AlertType,
} from "../budgets/entities/budget-alert.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/db/with-context", () => ({
  withSystemContext: (fn: () => unknown) => fn(),
  withUserContext: (_userId: string, fn: () => unknown) => fn(),
}));

/** One admin row as queryAdminRecipients' SQL returns it. */
function adminRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "admin-1",
    email: "ops@example.com",
    first_name: "Ada",
    email_enabled: true,
    ...overrides,
  };
}

function input(overrides: Partial<SystemAlertInput> = {}): SystemAlertInput {
  return {
    type: AlertType.BACKUP_FAILED,
    severity: AlertSeverity.CRITICAL,
    title: "Automatic backup failed",
    message: "The automatic backup for x failed: boom",
    data: { system: true },
    dedupeKey: "BACKUP_FAILED:user-1:2026-08-30",
    ...overrides,
  };
}

describe("SystemAlertService", () => {
  let manager: ManagerMock;
  let dataSource: DataSourceMock;
  let emailService: { getStatus: jest.Mock; sendMail: jest.Mock };
  let service: SystemAlertService;

  /**
   * Route the three statements the service issues. `insertResults` answers the
   * guarded INSERTs in order (an empty array is the conflict loser); admins is
   * what the recipient query returns.
   */
  function route(data: {
    admins?: unknown[];
    insertResults?: Array<Array<{ id: string }>>;
    adminQueryError?: Error;
  }): void {
    const inserts = [...(data.insertResults ?? [[{ id: "alert-row-1" }]])];
    manager.query.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("FROM users u")) {
        if (data.adminQueryError) return Promise.reject(data.adminQueryError);
        return Promise.resolve(data.admins ?? [adminRow()]);
      }
      if (text.includes("INSERT INTO budget_alerts")) {
        // The pg driver returns bare rows for INSERT (never the
        // [rows, rowCount] tuple) -- see common/db/query-result.ts.
        return Promise.resolve(
          inserts.length > 0 ? inserts.shift() : [{ id: "alert-row-n" }],
        );
      }
      if (text.includes("SET is_email_sent")) {
        return Promise.resolve([[], 1]);
      }
      return Promise.resolve([]);
    });
    manager.getRepository.mockReturnValue({
      findOne: jest.fn().mockResolvedValue({ language: "en" }),
    });
  }

  const insertStatements = () =>
    manager.query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO budget_alerts"),
    );

  const emailSentUpdates = () =>
    manager.query.mock.calls.filter(([sql]) =>
      String(sql).includes("SET is_email_sent"),
    );

  beforeEach(() => {
    jest.clearAllMocks();
    const mocks = createScopedDbMocks([
      [UserPreference, { findOne: jest.fn().mockResolvedValue(null) }],
    ]);
    manager = mocks.manager;
    dataSource = mocks.dataSource;
    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: true }),
      sendMail: jest.fn().mockResolvedValue(undefined),
    };
    service = new SystemAlertService(
      dataSource as never,
      emailService as never,
      {
        translate: (_key: string, options?: { defaultValue?: string }) =>
          options?.defaultValue ?? _key,
      } as never,
    );
  });

  describe("fan-out", () => {
    it("writes one guarded insert per active admin, carrying the dedupe key", async () => {
      route({
        admins: [adminRow(), adminRow({ id: "admin-2", email: "b@e.f" })],
      });
      const result = await service.raiseAdminAlert(input());

      expect(result.created).toBe(2);
      const inserts = insertStatements();
      expect(inserts).toHaveLength(2);
      for (const [sql, params] of inserts) {
        expect(String(sql)).toContain(
          "ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL",
        );
        expect(String(sql)).toContain("RETURNING id");
        expect(params[7]).toBe("BACKUP_FAILED:user-1:2026-08-30");
      }
      expect(inserts.map(([, params]) => params[0])).toEqual([
        "admin-1",
        "admin-2",
      ]);
    });

    it("emails only the insert winners: a conflict loser's recipient gets nothing", async () => {
      // Replica race: this replica wins admin-1's row and loses admin-2's.
      route({
        admins: [adminRow(), adminRow({ id: "admin-2", email: "b@e.f" })],
        insertResults: [[{ id: "row-1" }], []],
      });
      const result = await service.raiseAdminAlert(input());

      expect(result).toEqual({ created: 1, emailed: 1 });
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      expect(emailService.sendMail).toHaveBeenCalledWith(
        "ops@example.com",
        expect.any(String),
        expect.any(String),
      );
      expect(emailSentUpdates()).toHaveLength(1);
      expect(emailSentUpdates()[0][1]).toEqual(["row-1"]);
    });

    it("gives an admin with email disabled the row but no mail", async () => {
      route({
        admins: [
          adminRow({ id: "admin-quiet", email: "q@e.f", email_enabled: false }),
        ],
      });
      const result = await service.raiseAdminAlert(input());
      expect(result).toEqual({ created: 1, emailed: 0 });
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("one recipient's failure costs only that recipient", async () => {
      route({
        admins: [
          adminRow({ id: "admin-bad", email: "bad@e.f" }),
          adminRow({ id: "admin-good", email: "good@e.f" }),
        ],
      });
      emailService.sendMail.mockRejectedValueOnce(new Error("550 rejected"));
      const result = await service.raiseAdminAlert(input());
      expect(result).toEqual({ created: 2, emailed: 1 });
      // The failed send never marks its row as emailed.
      expect(emailSentUpdates()).toHaveLength(1);
    });

    it("warns once, not once per raise, when there is no administrator", async () => {
      route({ admins: [] });
      const warn = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => undefined);
      try {
        for (let i = 0; i < 4; i++) await service.raiseAdminAlert(input());
        const lines = warn.mock.calls
          .map((call) => String(call[0]))
          .filter((text) => text.includes("no active administrator"));
        expect(lines).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("email gating", () => {
    it("defaults to email for critical and warning, none for info and success", async () => {
      for (const [severity, expected] of [
        [AlertSeverity.CRITICAL, 1],
        [AlertSeverity.WARNING, 1],
        [AlertSeverity.INFO, 0],
        [AlertSeverity.SUCCESS, 0],
      ] as const) {
        emailService.sendMail.mockClear();
        route({});
        await service.raiseAdminAlert(input({ severity }));
        expect(emailService.sendMail).toHaveBeenCalledTimes(expected);
      }
    });

    it("honors an explicit email: false on a critical alert", async () => {
      route({});
      await service.raiseAdminAlert(input({ email: false }));
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("never emails SMTP_FAILURE, even when the caller asks for it", async () => {
      // The report that email is broken cannot travel by email; an attempt
      // would land in the very failure snapshot it was raised from.
      route({});
      await service.raiseAdminAlert(
        input({
          type: AlertType.SMTP_FAILURE,
          severity: AlertSeverity.CRITICAL,
          email: true,
          dedupeKey: "SMTP_FAILURE:2026-08-30",
        }),
      );
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("skips the send, keeping the row, when SMTP is unconfigured", async () => {
      emailService.getStatus.mockReturnValue({ configured: false });
      route({});
      const result = await service.raiseAdminAlert(input());
      expect(result).toEqual({ created: 1, emailed: 0 });
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });
  });

  describe("raiseUserAlert", () => {
    it("writes one row for the affected user and sends no email", async () => {
      route({});
      const result = await service.raiseUserAlert("user-9", {
        type: AlertType.SCHEDULED_POST_FAILED,
        severity: AlertSeverity.WARNING,
        title: "Rent could not be posted",
        message: "It failed",
        data: { system: true, scheduledId: "st-1" },
        dedupeKey: "SCHEDULED_POST_FAILED:st-1:2026-08-30",
      });
      expect(result).toEqual({ created: true });
      const inserts = insertStatements();
      expect(inserts).toHaveLength(1);
      expect(inserts[0][1][0]).toBe("user-9");
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("reports created: false for the dedupe loser", async () => {
      route({ insertResults: [[]] });
      const result = await service.raiseUserAlert("user-9", {
        type: AlertType.SCHEDULED_POST_FAILED,
        severity: AlertSeverity.WARNING,
        title: "t",
        message: "m",
        data: {},
        dedupeKey: "SCHEDULED_POST_FAILED:st-1:2026-08-30",
      });
      expect(result).toEqual({ created: false });
    });
  });

  describe("never throws", () => {
    it("swallows a recipient-query failure and reports zero", async () => {
      route({ adminQueryError: new Error("connection terminated") });
      const error = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      try {
        await expect(service.raiseAdminAlert(input())).resolves.toEqual({
          created: 0,
          emailed: 0,
        });
      } finally {
        error.mockRestore();
      }
    });

    it("swallows an insert failure on the user path", async () => {
      manager.query.mockRejectedValue(new Error("deadlock detected"));
      const error = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      try {
        await expect(
          service.raiseUserAlert("user-9", {
            type: AlertType.SCHEDULED_POST_FAILED,
            severity: AlertSeverity.WARNING,
            title: "t",
            message: "m",
            data: {},
            dedupeKey: "k",
          }),
        ).resolves.toEqual({ created: false });
      } finally {
        error.mockRestore();
      }
    });
  });

  describe("bounds", () => {
    it("every AlertType member fits the alert_type VARCHAR(30) column", () => {
      // A longer member would not fail loudly: PostgreSQL raises 22001 at
      // insert time, which the never-throws contract would swallow, so the
      // alert would silently never exist. Guard the enum instead.
      for (const member of Object.values(AlertType)) {
        expect(member.length).toBeLessThanOrEqual(30);
      }
    });

    it("truncates an oversized dedupe key deterministically rather than throwing", async () => {
      route({});
      const error = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      try {
        await service.raiseAdminAlert(
          input({ dedupeKey: "K".repeat(DEDUPE_KEY_MAX_LENGTH + 40) }),
        );
      } finally {
        error.mockRestore();
      }
      const [, params] = insertStatements()[0];
      expect(params[7]).toHaveLength(DEDUPE_KEY_MAX_LENGTH);
    });
  });
});
