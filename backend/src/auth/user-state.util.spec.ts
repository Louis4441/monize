import { checkUserAuthState } from "./user-state.util";

describe("checkUserAuthState", () => {
  const enforced = { enforceMustChangePassword: true };
  const unenforced = { enforceMustChangePassword: false };

  it("returns 'not_found' when user is null", () => {
    expect(checkUserAuthState(null, enforced)).toBe("not_found");
  });

  it("returns 'not_found' when user is undefined", () => {
    expect(checkUserAuthState(undefined, enforced)).toBe("not_found");
  });

  it("returns 'inactive' when user is deactivated", () => {
    expect(
      checkUserAuthState(
        { isActive: false, mustChangePassword: false },
        enforced,
      ),
    ).toBe("inactive");
  });

  it("returns 'must_change_password' when flagged and enforcement on", () => {
    expect(
      checkUserAuthState(
        { isActive: true, mustChangePassword: true },
        enforced,
      ),
    ).toBe("must_change_password");
  });

  it("ignores mustChangePassword when enforcement is off", () => {
    expect(
      checkUserAuthState(
        { isActive: true, mustChangePassword: true },
        unenforced,
      ),
    ).toBeNull();
  });

  it("returns null for an active, healthy user", () => {
    expect(
      checkUserAuthState(
        { isActive: true, mustChangePassword: false },
        enforced,
      ),
    ).toBeNull();
  });

  it("prefers 'inactive' over 'must_change_password' when both apply", () => {
    expect(
      checkUserAuthState(
        { isActive: false, mustChangePassword: true },
        enforced,
      ),
    ).toBe("inactive");
  });
});
