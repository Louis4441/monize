import { describe, it, expect } from 'vitest';

/**
 * Guard for issue #1244: a chart reduction must not reach a count, a total or
 * an export.
 *
 * The Debt Payoff Timeline built one array -- payment events, aggregated by
 * month, then sampled down to fit the axis -- and read "Payments Made" off it,
 * so a loan with 300 payments reported 61. Two rules keep that shut, and both
 * are scans because both mistakes are mechanical:
 *
 *  1. A payment count comes from `historicalPaymentCount`, never from filtering
 *     a schedule on `isProjected`. That filter is indistinguishable, at the
 *     call site, from one over the full history -- which is precisely why it
 *     survived review.
 *  2. A series produced by `chart-sampling.ts` may be handed to a chart and
 *     looked up in (a tooltip finding the row it hovers), but never MEASURED:
 *     a `.length`, `.reduce`, `.filter`, `.some`, `.every` or `.forEach` over a
 *     reduced series answers a question about pixels.
 *
 * The second scan reads one file at a time, so it can only see what a reduced
 * series is CALLED. An alias is therefore part of the rule rather than a hole
 * in it: a builder returning `{ points: chartPoints }` hands its caller a
 * reduced series under the name the unreduced one had, which is the same
 * conflation in a different place. Any name a reduced binding is aliased to,
 * inside the same file, is measured under the same ban -- and where a reduced
 * series crosses a module boundary it keeps its name, so the file that consumes
 * it is scanned for the name it actually uses.
 */
const allSources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** This guard, and the tests that plant the banned shapes deliberately. */
const EXEMPT = /\.(test|spec)\.tsx?$/;

/**
 * Blank out comments, keeping line numbering, so the scan reads CODE.
 *
 * The docblock above has to NAME the banned shapes to explain them, so a scan
 * over raw text would fail on its own documentation -- and the cheap way out of
 * that is a vaguer comment, which is the opposite of the point. Same stripper,
 * and the same two-way test, as `loan-history.guard.test.ts`.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => ' '.repeat(line.length));
}

const productionSources = Object.entries(allSources).filter(
  ([path]) => !EXEMPT.test(path),
);

/** A count of historical rows taken by filtering a schedule. */
const COUNT_BY_FILTER = /\.filter\([^\n]*isProjected[^\n]*\)\s*\.length/;

/** Aggregating over a series -- as opposed to drawing it or looking a row up. */
const MEASURED = ['length', 'reduce', 'filter', 'some', 'every', 'forEach', 'flatMap'];

/** Names bound directly to the result of a chart reduction, in one file. */
function reducedSeriesBindings(source: string): string[] {
  const binding =
    /(?:const|let)\s+(\w+)\s*=\s*(?:useMemo\(\s*\(\)\s*=>\s*)?(?:sampleStockSeries|bucketFlowSeries)\(/g;
  return [...source.matchAll(binding)].map((match) => match[1]);
}

/**
 * Those names plus any object field one of them is aliased to in the same file
 * (`return { points: chartPoints }`), since the alias is what a caller reads.
 */
function reducedSeriesNames(source: string): string[] {
  const bound = reducedSeriesBindings(source);
  const aliases = bound.flatMap((name) => [
    ...source.matchAll(new RegExp(`(\\w+)\\s*:\\s*${name}\\b`, 'g')),
  ].map((match) => match[1]));
  return [...new Set([...bound, ...aliases])];
}

describe('a chart reduction never reaches a figure (issue #1244)', () => {
  it('strips comments but still sees code', () => {
    const stripped = withoutComments(
      [
        '// rows.filter((r) => !r.isProjected).length',
        '/* rows.filter((r) => !r.isProjected).length */',
        'const n = rows.filter((r) => !r.isProjected).length;',
      ].join('\n'),
    );
    const lines = stripped.split('\n');
    expect(COUNT_BY_FILTER.test(lines[0])).toBe(false);
    expect(COUNT_BY_FILTER.test(lines[1])).toBe(false);
    expect(COUNT_BY_FILTER.test(lines[2])).toBe(true);
    // Line numbering must survive, or the offender report points at the wrong line.
    expect(lines).toHaveLength(3);
  });

  it('sees the sources it is meant to scan', () => {
    // An empty match set would make every assertion below vacuously true.
    expect(productionSources.length).toBeGreaterThan(100);
  });

  it('counts payments through historicalPaymentCount, never by filtering a schedule', () => {
    const offenders = productionSources.flatMap(([path, content]) =>
      withoutComments(content)
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => COUNT_BY_FILTER.test(line))
        .map(({ number, line }) => `${path}:${number}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it('has both loan reports reading the shared count', () => {
    // The rule above bans one shape; this one proves the replacement is in use,
    // so the two reports cannot give one loan two answers.
    for (const report of [
      '/src/components/reports/DebtPayoffTimelineReport.tsx',
      '/src/components/reports/LoanAmortizationReport.tsx',
    ]) {
      expect(allSources[report]).toContain('historicalPaymentCount');
    }
  });

  it('binds every reduced series to its own name, and those names are still here', () => {
    // Positive control: a rename or a deleted call site must not quietly make
    // the measurement scan below scan nothing.
    const bound = productionSources.flatMap(([path, content]) =>
      reducedSeriesBindings(withoutComments(content)).map((name) => `${path}: ${name}`),
    );
    expect(bound).toEqual([
      '/src/components/accounts/loan-detail/PayoffComparisonChart.tsx: chartPoints',
      '/src/components/accounts/loan-detail/ScenarioComparisonChart.tsx: indices',
      '/src/components/reports/DebtPayoffTimelineReport.tsx: chartSchedule',
      '/src/components/reports/DebtPayoffTimelineReport.tsx: distributionData',
    ]);
  });

  it('never measures a reduced series', () => {
    const offenders = productionSources.flatMap(([path, content]) => {
      const source = withoutComments(content);
      const names = reducedSeriesNames(source);
      if (names.length === 0) return [];
      const measured = new RegExp(
        `\\b(${names.join('|')})\\s*\\.\\s*(${MEASURED.join('|')})\\b`,
      );
      return source
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => measured.test(line))
        .map(({ number, line }) => `${path}:${number}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });

  it('measures an aliased reduced series under the same ban', () => {
    // `buildPayoffComparisonSeries` returned `{ points: chartPoints }` for one
    // commit, which put the caller's `points.length` beyond this scan.
    const planted = withoutComments(
      [
        'const chartRows = sampleStockSeries(rows);',
        'return { points: chartRows };',
        'const n = points.length;',
      ].join('\n'),
    );
    const names = reducedSeriesNames(planted);
    expect(names).toEqual(['chartRows', 'points']);
    const measured = new RegExp(`\\b(${names.join('|')})\\s*\\.\\s*(${MEASURED.join('|')})\\b`);
    expect(planted.split('\n').some((line) => measured.test(line))).toBe(true);
  });

  it('detects a planted measurement', () => {
    // Negative control for the scan above: without it, deleting the regex would
    // leave every assertion passing.
    const planted = withoutComments(
      ['const chartRows = sampleStockSeries(rows);', 'const n = chartRows.length;'].join('\n'),
    );
    const names = reducedSeriesNames(planted);
    expect(names).toEqual(['chartRows']);
    const measured = new RegExp(`\\b(${names.join('|')})\\s*\\.\\s*(${MEASURED.join('|')})\\b`);
    expect(planted.split('\n').some((line) => measured.test(line))).toBe(true);
  });
});
