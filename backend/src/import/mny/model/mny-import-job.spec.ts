import {
  BALANCE_TOLERANCE,
  IMPORT_JOB_STATUSES,
  MNY_IMPORT_PHASES,
  balanceMatches,
} from "./mny-import-job";

describe("mny import job model", () => {
  it("declares the four job statuses", () => {
    expect([...IMPORT_JOB_STATUSES]).toEqual([
      "pending",
      "running",
      "completed",
      "failed",
    ]);
  });

  it("orders the phases the way the import runs them", () => {
    expect(MNY_IMPORT_PHASES.indexOf("reference")).toBeLessThan(
      MNY_IMPORT_PHASES.indexOf("transactions"),
    );
    expect(MNY_IMPORT_PHASES.indexOf("transactions")).toBeLessThan(
      MNY_IMPORT_PHASES.indexOf("verifying"),
    );
    expect(MNY_IMPORT_PHASES[0]).toBe("preparing");
    expect(MNY_IMPORT_PHASES[MNY_IMPORT_PHASES.length - 1]).toBe("verifying");
  });

  describe("balanceMatches", () => {
    it("accepts an exact match", () => {
      expect(balanceMatches(0)).toBe(true);
    });

    it("accepts sub-half-cent drift in either direction", () => {
      expect(balanceMatches(BALANCE_TOLERANCE)).toBe(true);
      expect(balanceMatches(-BALANCE_TOLERANCE)).toBe(true);
      expect(balanceMatches(0.001)).toBe(true);
    });

    it("rejects a real discrepancy", () => {
      expect(balanceMatches(0.01)).toBe(false);
      expect(balanceMatches(-125.5)).toBe(false);
    });
  });
});
