import { describe, it, expect } from 'vitest';
import { CHART_MAX_POINTS, bucketFlowSeries, sampleStockSeries } from './chart-sampling';

describe('sampleStockSeries', () => {
  it('leaves a series that already fits alone', () => {
    const rows = Array.from({ length: CHART_MAX_POINTS }, (_, i) => i);
    expect(sampleStockSeries(rows)).toEqual(rows);
  });

  it('returns a copy rather than the caller\'s array', () => {
    const rows = [1, 2, 3];
    expect(sampleStockSeries(rows)).not.toBe(rows);
  });

  it('reduces a long series to at most the point budget, plus the kept rows', () => {
    const rows = Array.from({ length: 360 }, (_, i) => i);
    const sampled = sampleStockSeries(rows);
    // A stride of ceil(360/60) = 6 yields 60 rows (0, 6, ... 354); index 359 is
    // not among them and is appended, so the budget is a bound and not a count.
    expect(sampled).toHaveLength(CHART_MAX_POINTS + 1);
    expect(sampled[0]).toBe(0);
    expect(sampled[sampled.length - 1]).toBe(359);
  });

  it('always keeps the last row, even when the stride steps past it', () => {
    const rows = Array.from({ length: 121 }, (_, i) => i);
    const sampled = sampleStockSeries(rows);
    expect(sampled[sampled.length - 1]).toBe(120);
  });

  it('keeps the rows `keep` marks, whatever the stride', () => {
    const rows = Array.from({ length: 600 }, (_, i) => i);
    // 401 is not a multiple of the stride (10), so only `keep` saves it.
    const sampled = sampleStockSeries(rows, { keep: (row) => row === 401 });
    expect(sampled).toContain(401);
  });

  it('emits every index once, in order', () => {
    const rows = Array.from({ length: 200 }, (_, i) => i);
    const sampled = sampleStockSeries(rows, { keep: (_row, index) => index % 4 === 0 });
    expect(new Set(sampled).size).toBe(sampled.length);
    expect([...sampled].sort((a, b) => a - b)).toEqual(sampled);
  });

  it('handles an empty series', () => {
    expect(sampleStockSeries([])).toEqual([]);
  });
});

describe('bucketFlowSeries', () => {
  const sum = (group: number[]) => group.reduce((total, n) => total + n, 0);

  it('passes a series that already fits through one row at a time', () => {
    const rows = [1, 2, 3];
    expect(bucketFlowSeries(rows, sum)).toEqual([1, 2, 3]);
  });

  it('conserves every value -- no period is dropped', () => {
    const rows = Array.from({ length: 500 }, (_, i) => i + 1);
    const bucketed = bucketFlowSeries(rows, sum);
    expect(sum(bucketed)).toBe(sum(rows));
  });

  it('stays within the point budget', () => {
    const rows = Array.from({ length: 500 }, () => 1);
    expect(bucketFlowSeries(rows, sum).length).toBeLessThanOrEqual(CHART_MAX_POINTS);
  });

  it('never merges across a boundary', () => {
    // 100 historical rows then 100 projected: at a stride of 4 the 25th bucket
    // would straddle the two without the boundary.
    const rows = [
      ...Array.from({ length: 100 }, () => ({ value: 1, projected: false })),
      ...Array.from({ length: 100 }, () => ({ value: 1, projected: true })),
    ];
    const bucketed = bucketFlowSeries(
      rows,
      (group) => ({
        value: group.reduce((total, row) => total + row.value, 0),
        kinds: new Set(group.map((row) => row.projected)).size,
      }),
      { boundary: (row) => row.projected },
    );
    expect(bucketed.every((bucket) => bucket.kinds === 1)).toBe(true);
    expect(bucketed.reduce((total, bucket) => total + bucket.value, 0)).toBe(200);
  });

  it('keeps one bucket per run when the runs outnumber the budget', () => {
    // Alternating rows: 120 runs of one row each. Merging any two would put two
    // kinds in one bar, so the budget yields to the boundary.
    const rows = Array.from({ length: 120 }, (_, i) => i % 2 === 0);
    const bucketed = bucketFlowSeries(rows, (group) => group.length, {
      boundary: (row) => row,
      maxPoints: 10,
    });
    expect(bucketed).toHaveLength(120);
  });

  it('handles an empty series', () => {
    expect(bucketFlowSeries([], sum)).toEqual([]);
  });
});
