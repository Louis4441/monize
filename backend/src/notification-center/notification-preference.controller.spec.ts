import { BadRequestException } from "@nestjs/common";

import { NotificationPreferenceController } from "./notification-preference.controller";
import { NotificationCategory } from "./entities/notification.entity";

describe("NotificationPreferenceController", () => {
  const preferences = { list: jest.fn(), updatePreference: jest.fn() };
  const controller = new NotificationPreferenceController(preferences as never);
  const req = { user: { id: "u1" } };

  afterEach(() => jest.clearAllMocks());

  it("lists the caller's own preferences", () => {
    preferences.list.mockReturnValue(["x"]);
    expect(controller.list(req)).toEqual(["x"]);
    expect(preferences.list).toHaveBeenCalledWith("u1");
  });

  it("updates an exposed category, keyed on the JWT user", () => {
    controller.update(req, NotificationCategory.PAYMENTS, {
      email: false,
      emailNotification: true,
      throttleMinutes: 15,
    });
    expect(preferences.updatePreference).toHaveBeenCalledWith(
      "u1",
      NotificationCategory.PAYMENTS,
      { email: false, emailNotification: true, throttleMinutes: 15 },
    );
  });

  it("passes a partial update through untouched (only the field sent)", () => {
    controller.update(req, NotificationCategory.BUDGETS, { email: false });
    expect(preferences.updatePreference).toHaveBeenCalledWith(
      "u1",
      NotificationCategory.BUDGETS,
      {
        email: false,
        emailNotification: undefined,
        throttleMinutes: undefined,
      },
    );
  });

  it("refuses a real category the matrix does not expose yet", () => {
    expect(() =>
      controller.update(req, NotificationCategory.SYSTEM, { email: true }),
    ).toThrow(BadRequestException);
    expect(preferences.updatePreference).not.toHaveBeenCalled();
  });

  it("refuses an empty body rather than writing a default row", () => {
    expect(() =>
      controller.update(req, NotificationCategory.PAYMENTS, {}),
    ).toThrow(BadRequestException);
    expect(preferences.updatePreference).not.toHaveBeenCalled();
  });
});
