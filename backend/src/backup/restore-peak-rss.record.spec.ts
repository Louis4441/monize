import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
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
 * claims and states, as failing-or-passing assertions rather than prose, the gap
 * between what the code models and what the measurement found. Two of these tests
 * pin a **defect**: they assert that the modeled multiple is below the measured
 * one, which is the situation today. When the derivation is fixed they must be
 * rewritten to assert the property instead -- that is the intended churn, and the
 * comment on each says so.
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

  /**
   * DEFECT PINNED. `PEAK_MULTIPLE = 3` is a floor argued from allocation
   * counting; the measurement puts the decode phase alone at roughly twice that.
   * Rewrite this to `expect(PEAK_MULTIPLE).toBeGreaterThanOrEqual(...)` when the
   * derivation is fixed -- the failure of this test is then the good news.
   */
  it("shows the modeled multiple is below the measured one", () => {
    expect(record.maxImpliedMultiple).not.toBeNull();
    expect(record.maxImpliedMultiple as number).toBeGreaterThan(PEAK_MULTIPLE);
  });

  /**
   * DEFECT PINNED, and the sharp end of it: 304 MiB is exactly the headroom the
   * model leaves on the chart's default 400 MiB pod (400 minus the 96 MiB
   * baseline), and four of the five artifacts cannot be decoded inside it at all.
   * So "one slot with 4 MiB spare" describes a restore that does not complete.
   */
  it("shows the model's own headroom cannot decode the artifact it admits", () => {
    const container = 400 * MIB;
    const headroomMib = Math.round(
      (container - restoreProcessBaselineBytes(container)) / MIB,
    );
    expect(headroomMib).toBe(304);
    // The gate admits one restore at that container size, sized by the derived
    // expanded ceiling -- so those are the two numbers the sweep has to match.
    expect(computeRestoreProcessingSlots(container)).toBe(1);
    const modeledCeiling = resolveRestoreExpandedLimitBytes(
      undefined,
      container,
    );

    // The largest size swept stands in for that ceiling; assert it is actually
    // close to it, or this test would pass on an artifact nobody would admit.
    const largestSwept = Math.max(
      ...record.sweeps.map((sweep) => sweep.targetExpandedBytes),
    );
    expect(largestSwept / modeledCeiling).toBeGreaterThan(0.9);

    const atHeadroom = record.sweeps.find(
      (sweep) =>
        sweep.childHeapMib === headroomMib &&
        sweep.targetExpandedBytes === largestSwept,
    );
    expect(atHeadroom).toBeDefined();
    expect((atHeadroom as Sweep).exhausted.length).toBeGreaterThan(0);
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
