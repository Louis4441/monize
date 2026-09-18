/**
 * The INVESTED part of a portfolio value point, for the surfaces that draw it.
 *
 * Cash held in an investment account is not an investment, so "Portfolio value
 * over time", the dashboard's portfolio widget and the Portfolio Value report
 * plot the securities alone: a deposit that has not been invested must not draw
 * as a rise in the portfolio's value, and the chart's headline figures read the
 * invested part's P&L and time-weighted return so the chart and the
 * "Portfolio performance" card cannot disagree on one page
 * (INV-PORTRESULT-002, `docs/specs/portfolio-period-result.md` section 10.7).
 *
 * The net worth chart is net worth and keeps reading `value`; so do the daily
 * movement notification and the calendar's day layer, which measure the
 * account rather than the investments.
 *
 * `securitiesValue` is absent from a response an older backend produced
 * mid-deploy, and absent is NO INFORMATION rather than zero: such a point falls
 * back to the whole value, which is exactly what it drew before. Drawing zero
 * would claim the portfolio held nothing.
 */
export function investedValue(point: {
  value: number;
  securitiesValue?: number | null;
}): number {
  return point.securitiesValue ?? point.value;
}
