import {
  MAX_WARNING_SAMPLES,
  MNY_WARNING_CODES,
  MnyWarning,
  summarizeWarnings,
} from "./mny-warnings";

describe("mny warnings", () => {
  it("has unique codes", () => {
    expect(new Set(MNY_WARNING_CODES).size).toBe(MNY_WARNING_CODES.length);
  });

  describe("summarizeWarnings", () => {
    it("returns nothing for no warnings", () => {
      expect(summarizeWarnings([])).toEqual([]);
    });

    it("groups by code and counts", () => {
      const warnings: MnyWarning[] = [
        { code: "degeneratePayeeSkipped", subject: "#" },
        { code: "degeneratePayeeSkipped", subject: "*" },
        { code: "unknownAccountType", subject: "Mystery", detail: "at=99" },
      ];

      expect(summarizeWarnings(warnings)).toEqual([
        { code: "unknownAccountType", count: 1, samples: ["Mystery"] },
        { code: "degeneratePayeeSkipped", count: 2, samples: ["#", "*"] },
      ]);
    });

    it("orders groups by the declared code order, not by first appearance", () => {
      const summaries = summarizeWarnings([
        { code: "balanceMismatch", subject: "Chequing" },
        { code: "missingTable", subject: "BILL" },
      ]);

      expect(summaries.map((entry) => entry.code)).toEqual([
        "missingTable",
        "balanceMismatch",
      ]);
    });

    it("caps samples so a warning over thousands of rows stays a small payload", () => {
      const warnings: MnyWarning[] = Array.from({ length: 4000 }, (_, i) => ({
        code: "unusableTransaction" as const,
        subject: `htrn=${i}`,
      }));

      const [summary] = summarizeWarnings(warnings);

      expect(summary.count).toBe(4000);
      expect(summary.samples).toHaveLength(MAX_WARNING_SAMPLES);
      expect(summary.samples[0]).toBe("htrn=0");
    });

    it("omits missing subjects from the samples but still counts them", () => {
      const summary = summarizeWarnings([
        { code: "missingField", detail: "CRNC.fHidden" },
        { code: "missingField", subject: "CRNC", detail: "fHidden" },
      ]);

      expect(summary).toEqual([
        { code: "missingField", count: 2, samples: ["CRNC"] },
      ]);
    });
  });
});
