import { NotificationReminderService } from "./notification-reminder.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

/**
 * RLS smoke for the reminder cron's entry point (task C2/C4).
 *
 * Unlike the per-service spec, this suite does NOT mock `withScopedDb` or
 * `with-context`: the real implementations run (at the default RLS_MODE=off), so
 * every DB access on the cron path must find the ambient context seeded by the
 * wrappers -- `withSystemContext` for the cross-user sweep and atomic claim,
 * `withUserContext` for each re-emit -- or `withScopedDb` throws its
 * missing-context error. A context throw would surface as a logged
 * "Failed to fire due reminders", so the assertion is that nothing is logged.
 */
describe("notification-center reminder RLS context smoke (real withScopedDb)", () => {
  it("fireDue runs its sweep and claim under system context and re-emits under user context", async () => {
    const { dataSource, manager } = createScopedDbMocks();
    // sweep -> nothing; claim -> one due row for a user, which the re-emit then
    // processes under that user's context.
    manager.query.mockResolvedValueOnce([[], 0]).mockResolvedValueOnce([
      [
        {
          id: "rem-1",
          user_id: "3f1f8a52-2f0e-4b6d-9a56-0d6a3f1c2b4e",
          alert_type: "BILL_DUE",
          severity: "warning",
          title: "Rent due",
          message: "Rent is due",
          data: {},
          target: "/bills",
          dedupe_base: "BILL_DUE",
          fire_count: 1,
        },
      ],
      1,
    ]);

    // The write door is a mock: the re-emit only needs to be reached under the
    // per-user context, not to write a row.
    const notifications = { create: jest.fn().mockResolvedValue({ id: "n" }) };
    const service = new NotificationReminderService(
      dataSource as never,
      notifications as never,
    );
    const errorSpy = jest
      .spyOn(service["logger"], "error")
      .mockImplementation(() => undefined);

    await service.fireDue();

    // No context throw anywhere on the path.
    expect(errorSpy).not.toHaveBeenCalled();
    // Sweep + claim both ran, and the due row was re-emitted.
    expect(manager.query).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledTimes(1);
  });

  it("real withScopedDb still refuses the request-path methods without a context wrapper", async () => {
    const { dataSource } = createScopedDbMocks();
    const service = new NotificationReminderService(
      dataSource as never,
      { create: jest.fn() } as never,
    );
    // list() has no context wrapper of its own -- it inherits the request
    // interceptor's context in production -- so with none seeded here, the real
    // withScopedDb refuses it.
    await expect(service.list("u1")).rejects.toThrow();
  });
});
