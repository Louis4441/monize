import {
  isoWeekBucket,
  SMTP_FAILURE_LOOKBACK_MS,
  SystemAlertMonitorService,
} from "./system-alert-monitor.service";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import type { EmailFailureSnapshot } from "../notifications/email.service";

describe("SystemAlertMonitorService", () => {
  let systemAlerts: { raiseAdminAlert: jest.Mock };
  let emailService: {
    getStatus: jest.Mock;
    getFailureSnapshot: jest.Mock;
  };
  let env: Record<string, string | undefined>;
  let service: SystemAlertMonitorService;

  function snapshot(
    overrides: Partial<EmailFailureSnapshot> = {},
  ): EmailFailureSnapshot {
    return {
      lastFailureAt: null,
      lastFailureMessage: null,
      lastSuccessAt: null,
      failuresSinceSuccess: 0,
      recipientRejections: 0,
      ...overrides,
    };
  }

  beforeEach(() => {
    env = {};
    systemAlerts = {
      raiseAdminAlert: jest.fn().mockResolvedValue({ created: 1, emailed: 1 }),
    };
    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: true }),
      getFailureSnapshot: jest.fn().mockReturnValue(snapshot()),
    };
    service = new SystemAlertMonitorService(
      { get: jest.fn((name: string) => env[name]) } as never,
      systemAlerts as never,
      emailService as never,
    );
  });

  describe("encryption key check", () => {
    it("raises a weekly-bucketed admin alert when neither key name supplies one", async () => {
      await service.checkEncryptionKey(new Date("2026-08-30T12:00:00Z"));
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.ENCRYPTION_KEY_MISSING,
          severity: NotificationSeverity.WARNING,
          dedupeKey: "ENCRYPTION_KEY_MISSING:2026-W35",
          data: { system: true },
        }),
      );
    });

    it("stays silent when ENCRYPTION_KEY is set", async () => {
      env.ENCRYPTION_KEY = "k".repeat(32);
      await service.checkEncryptionKey();
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("stays silent when the legacy AI_ENCRYPTION_KEY supplies the key", async () => {
      env.AI_ENCRYPTION_KEY = "k".repeat(32);
      await service.checkEncryptionKey();
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("treats a key below the length floor as absent -- it cannot encrypt anything", async () => {
      env.ENCRYPTION_KEY = "too-short";
      await service.checkEncryptionKey(new Date("2026-08-30T12:00:00Z"));
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledTimes(1);
    });

    it("runs on the sweep, not on bootstrap", async () => {
      // Boot-only never fired on a fresh install (no administrator exists yet
      // when the server first starts, so the fan-out stood down), never
      // re-raised on the weekly bucket it is keyed on, and made Nest await a
      // per-administrator SMTP fan-out inside `app.listen()`.
      expect(
        (service as unknown as Record<string, unknown>).onApplicationBootstrap,
      ).toBeUndefined();

      await service.sweepSystemHealth(new Date("2026-08-30T12:00:00Z"));
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.ENCRYPTION_KEY_MISSING,
        }),
      );
    });

    it("keeps re-raising on later sweeps, so a fresh install is told once an admin exists", async () => {
      // The weekly dedupe key -- not the number of sweeps -- is what bounds
      // the noise, and a raise that found no administrator has written
      // nothing to dedupe against.
      systemAlerts.raiseAdminAlert.mockResolvedValue({
        created: 0,
        emailed: 0,
      });
      await service.sweepSystemHealth(new Date("2026-08-30T12:00:00Z"));
      await service.sweepSystemHealth(new Date("2026-08-30T12:15:00Z"));
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledTimes(2);
    });
  });

  describe("SMTP health sweep", () => {
    const now = new Date("2026-08-30T12:00:00Z");

    it("is not stopped by the encryption-key check beside it", async () => {
      // One handler, two independent facts: a configured key must not mean
      // the SMTP check is skipped, and vice versa.
      env.ENCRYPTION_KEY = "k".repeat(32);
      emailService.getFailureSnapshot.mockReturnValue(
        snapshot({ lastFailureAt: new Date("2026-08-30T11:50:00Z") }),
      );
      await service.sweepSystemHealth(now);
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledTimes(1);
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationType.SMTP_FAILURE }),
      );
    });

    it("raises a daily-bucketed, never-emailed alert when the last send failed", async () => {
      emailService.getFailureSnapshot.mockReturnValue(
        snapshot({
          lastFailureAt: new Date("2026-08-30T11:50:00Z"),
          lastFailureMessage: "ECONNREFUSED 10.0.0.1:587",
          failuresSinceSuccess: 3,
        }),
      );
      await service.sweepEmailHealth(now);
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.SMTP_FAILURE,
          severity: NotificationSeverity.WARNING,
          dedupeKey: "SMTP_FAILURE:2026-08-30",
          email: false,
          data: expect.objectContaining({
            system: true,
            lastError: "ECONNREFUSED 10.0.0.1:587",
            failuresSinceSuccess: 3,
          }),
        }),
      );
    });

    it("stays silent when a success postdates the failure -- delivery recovered", async () => {
      emailService.getFailureSnapshot.mockReturnValue(
        snapshot({
          lastFailureAt: new Date("2026-08-30T11:00:00Z"),
          lastSuccessAt: new Date("2026-08-30T11:30:00Z"),
        }),
      );
      await service.sweepEmailHealth(now);
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("stays silent when nothing has failed", async () => {
      await service.sweepEmailHealth(now);
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("ignores a failure older than the lookback -- yesterday's alert already exists", async () => {
      emailService.getFailureSnapshot.mockReturnValue(
        snapshot({
          lastFailureAt: new Date(
            now.getTime() - SMTP_FAILURE_LOOKBACK_MS - 60_000,
          ),
        }),
      );
      await service.sweepEmailHealth(now);
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("stays silent when SMTP is not configured -- a setup state, not a failure", async () => {
      emailService.getStatus.mockReturnValue({ configured: false });
      emailService.getFailureSnapshot.mockReturnValue(
        snapshot({ lastFailureAt: new Date("2026-08-30T11:50:00Z") }),
      );
      await service.sweepEmailHealth(now);
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
    });
  });

  describe("isoWeekBucket", () => {
    it("is stable within an ISO week and fresh the week after", () => {
      // 2026-08-24 is a Monday; 2026-08-30 the Sunday of the same ISO week.
      expect(isoWeekBucket(new Date("2026-08-24T00:00:00Z"))).toBe("2026-W35");
      expect(isoWeekBucket(new Date("2026-08-30T23:59:59Z"))).toBe("2026-W35");
      expect(isoWeekBucket(new Date("2026-08-31T00:00:00Z"))).toBe("2026-W36");
    });

    it("assigns the year-boundary days to the ISO year that owns them", () => {
      // 2026-01-01 falls on a Thursday, so week 1 of 2026 starts 2025-12-29.
      expect(isoWeekBucket(new Date("2025-12-29T12:00:00Z"))).toBe("2026-W01");
      expect(isoWeekBucket(new Date("2026-01-01T12:00:00Z"))).toBe("2026-W01");
      // 2027-01-01 is a Friday in the same ISO week as 2026-12-28 (Monday).
      expect(isoWeekBucket(new Date("2026-12-28T12:00:00Z"))).toBe("2026-W53");
      expect(isoWeekBucket(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
    });
  });
});
