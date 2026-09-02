import { BadRequestException } from "@nestjs/common";

import { NotificationPreferenceController } from "./notification-preference.controller";
import { NotificationCategory } from "./entities/notification.entity";

describe("NotificationPreferenceController", () => {
  const preferences = { list: jest.fn(), setEmail: jest.fn() };
  const controller = new NotificationPreferenceController(preferences as never);
  const req = { user: { id: "u1" } };

  afterEach(() => jest.clearAllMocks());

  it("lists the caller's own preferences", () => {
    preferences.list.mockReturnValue(["x"]);
    expect(controller.list(req)).toEqual(["x"]);
    expect(preferences.list).toHaveBeenCalledWith("u1");
  });

  it("sets email for an exposed category, keyed on the JWT user", () => {
    controller.setEmail(req, NotificationCategory.PAYMENTS, { email: false });
    expect(preferences.setEmail).toHaveBeenCalledWith(
      "u1",
      NotificationCategory.PAYMENTS,
      false,
    );
  });

  it("refuses a real category the matrix does not expose yet", () => {
    expect(() =>
      controller.setEmail(req, NotificationCategory.SYSTEM, { email: true }),
    ).toThrow(BadRequestException);
    expect(preferences.setEmail).not.toHaveBeenCalled();
  });
});
