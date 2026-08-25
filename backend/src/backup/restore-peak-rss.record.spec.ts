import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEASURED_PEAK_MULTIPLE,
  PEAK_MULTIPLE,
  resolveRestoreExpandedLimitBytes,
  restoreProcessBaselineBytes,
} from "./backup-limits";
import { computeRestoreProcessingSlots } from "./restore-processing-gate";

/**
 * The committed peak-RSS measurement, and what it says about the constants
 * derived from `PEAK_MULTIPLE` (DR-F3RB-004, issue #1073).
 *
 * `restore-peak-rss.harness.ts` produces the record; this holds it to its own
 * claims, and holds the constants in `backup-limits.ts` to the record. Two of
 * these tests used to pin a **defect** -- that the modeled multiple was below the
 * measured one, and that the model's own headroom could not decode what it
 * admitted. The derivation has since been solved out of the capacity, so both now
 * assert the property, which is what the churn was for.
 *
 * The constant is checked against the record in both directions on purpose: a
 * measurement nobody derives from is decoration, and a constant nobody measured is
 * what this whole finding was about.
 */

interface CaseResult {
  id: string;
  outcome: "measured" | "heap-exhausted" | "failed";
  runtime: "compiled" | "ts-node";
  expandedBytes: number;
  baselineRssBytes: number;
  peakRssBytes: number;
  impliedMultiple: number | null;
}

interface Sweep {
  targetExpandedBytes: number;
  childHeapMib: number | null;
  cases: CaseResult[];
  maxImpliedMultiple: number | null;
  exhausted: string[];
}

interface Record_ {
  issue: number;
  finding: string;
  coverage: string;
  cgroupConstrained: boolean;
  environment: { node: string; cgroupMemoryLimitBytes: number | null };
  targetExpandedBytesSwept: number[];
  runsPerCase: number;
  sweeps: Sweep[];
  maxImpliedMultiple: number | null;
}

const MIB = 1024 * 1024;

const record = JSON.parse(
  readFileSync(join(__dirname, "restore-peak-rss.record.json"), "utf8"),
) as Record_;

const measuredCases = (): CaseResult[] =>
  record.sweeps.flatMap((sweep) => sweep.cases);

describe("the committed restore peak-RSS record", () => {
  it("measures the finding it claims to", () => {
    expect(record.issue).toBe(1073);
    expect(record.finding).toBe("DR-F3RB-004");
    expect(record.sweeps.length).toBeGreaterThan(0);
    expect(measuredCases().length).toBeGreaterThan(0);
  });

  /**
   * A measurement taken under ts-node measures the TypeScript compiler as well
   * as the restore. The harness knows the difference and records it, so a record
   * produced the wrong way cannot be mistaken for evidence.
   */
  it("was taken from the compiled build", () => {
    for (const entry of measuredCases()) {
      expect(entry.runtime).toBe("compiled");
    }
  });

  it("says what it does not cover, rather than leaving the reader to assume", () => {
    // The two caveats that decide how the number may be used: the database phase
    // is not in it, and no cgroup limit was enforced during the run.
    expect(record.coverage).toContain("LOWER BOUND");
    expect(record.coverage).toMatch(/insert transaction are NOT measured/);
    expect(typeof record.cgroupConstrained).toBe("boolean");
    if (!record.cgroupConstrained) {
      expect(record.environment.cgroupMemoryLimitBytes).toBeNull();
    }
  });

  it("keeps every case's own numbers, not just the maximum", () => {
    // A single aggregate cannot be re-examined. Each case carries the expanded
    // size it decoded and the peak it reached, so a later reader can recompute.
    for (const entry of measuredCases()) {
      if (entry.outcome === "heap-exhausted") {
        expect(entry.impliedMultiple).toBeNull();
        continue;
      }
      expect(entry.expandedBytes).toBeGreaterThan(0);
      expect(entry.peakRssBytes).toBeGreaterThan(entry.baselineRssBytes);
      expect(entry.impliedMultiple).toBeCloseTo(
        (entry.peakRssBytes - entry.baselineRssBytes) / entry.expandedBytes,
        2,
      );
    }
  });

  it("is the source of the constant the code budgets with", () => {
    // Both directions. The constant may not drift from the record, and the record
    // may not be regenerated downwards without the constant following it.
    expect(MEASURED_PEAK_MULTIPLE).toBeCloseTo(
      record.maxImpliedMultiple as number,
      3,
    );
    expect(PEAK_MULTIPLE).toBeGreaterThanOrEqual(MEASURED_PEAK_MULTIPLE);
  });

  /**
   * The defect this record was taken to expose, and the fix stated against the
   * same numbers. The old model admitted a 100 MiB artifact into 304 MiB of
   * headroom on the chart's default pod, and the sweep at that heap cap shows four
   * of five 96 MiB artifacts could not be decoded there at all. What the
   * derivation admits now is small enough that the measurement it was taken from
   * completed comfortably.
   */
  it("admits only an artifact the measurement shows can be decoded", () => {
    const container = 400 * MIB;
    const headroomMib = Math.round(
      (container - restoreProcessBaselineBytes(container)) / MIB,
    );
    const admitted = resolveRestoreExpandedLimitBytes(undefined, container);
    expect(computeRestoreProcessingSlots(container)).toBe(1);

    // The old ceiling, which the record shows does not decode inside the old
    // headroom. Both numbers come from the record rather than from memory.
    const failedAt = record.sweeps.find((sweep) => sweep.exhausted.length > 0);
    expect(failedAt).toBeDefined();
    const failing = failedAt as Sweep;
    expect(admitted).toBeLessThan(failing.targetExpandedBytes);

    // And the record has to *demonstrate* what is admitted, not merely be smaller
    // than what failed: some artifact at least as large as the new ceiling was
    // decoded inside a heap no larger than the headroom this pod leaves free.
    // Without this the derivation could shrink to any number and still pass.
    const demonstrated = record.sweeps.filter(
      (sweep) =>
        sweep.exhausted.length === 0 &&
        sweep.childHeapMib !== null &&
        sweep.childHeapMib <= headroomMib &&
        sweep.targetExpandedBytes >= admitted,
    );
    expect(demonstrated.length).toBeGreaterThan(0);
  });

  /**
   * Above the point where the decode completes, the peak stops moving. That
   * matters for what the number means: it is not V8 hoarding because it was
   * allowed to -- the same artifact costs the same at 512 MiB and at 1 GiB -- so
   * capping the heap does not make a restore cheaper, it only decides whether it
   * finishes.
   */
  it("shows the cost is the artifact's, not the heap limit's", () => {
    // Compared within one artifact size, because the multiple varies with size
    // (see below): pooling sizes would compare two different questions.
    const bySize = new Map<number, number[]>();
    for (const sweep of record.sweeps) {
      if (sweep.exhausted.length > 0 || sweep.maxImpliedMultiple === null) {
        continue;
      }
      bySize.set(sweep.targetExpandedBytes, [
        ...(bySize.get(sweep.targetExpandedBytes) ?? []),
        sweep.maxImpliedMultiple,
      ]);
    }
    const comparable = [...bySize.values()].filter(
      (values) => values.length >= 2,
    );
    expect(comparable.length).toBeGreaterThan(0);
    for (const values of comparable) {
      expect(Math.max(...values) - Math.min(...values)).toBeLessThan(0.5);
    }
  });

  /**
   * The model's shape, not just its constant, is optimistic: a *smaller*
   * artifact costs a *larger* multiple, because part of the cost does not scale
   * with the payload. So `peak = multiple * expanded` cannot be tuned by one
   * number that is right everywhere -- the honest form has an intercept, and any
   * single multiple has to be the worst one over the sizes a deployment admits.
   */
  it("shows the multiple rises as the artifact shrinks", () => {
    const worstBySize = [...record.sweeps]
      .filter(
        (sweep) => sweep.exhausted.length === 0 && sweep.maxImpliedMultiple,
      )
      .reduce((map, sweep) => {
        const current = map.get(sweep.targetExpandedBytes) ?? 0;
        return map.set(
          sweep.targetExpandedBytes,
          Math.max(current, sweep.maxImpliedMultiple as number),
        );
      }, new Map<number, number>());

    const bySizeAscending = [...worstBySize.entries()].sort(
      (a, b) => a[0] - b[0],
    );
    expect(bySizeAscending.length).toBeGreaterThanOrEqual(2);
    const smallest = bySizeAscending[0][1];
    const largest = bySizeAscending[bySizeAscending.length - 1][1];
    expect(smallest).toBeGreaterThan(largest);
  });
});
