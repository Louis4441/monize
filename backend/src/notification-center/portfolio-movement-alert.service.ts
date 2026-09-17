import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { UserPreference } from "../users/entities/user-preference.entity";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { returnedRows } from "../common/db/query-result";
import { loadExternalFlowSubtotals } from "../securities/external-flow.util";
import { todayYMD } from "../common/date-utils";
import { preferredCurrency } from "../common/default-currency.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { PortfolioService } from "../securities/portfolio.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  NotificationSeverity,
  NotificationType,
} from "./entities/notification.entity";
import { CreateNotificationInput } from "./notification.service";
import { FlowSubtotal, foldExternalFlow } from "./portfolio-flow.util";
import {
  HeldPosition,
  stalePricedSecurityIds,
} from "./portfolio-price-freshness.util";
import {
  NumberT,
  defaultNumberT,
  numberFormatterFor,
} from "../common/number-locale.util";
import {
  FiredMovement,
  MovementInputs,
  decideMovement,
} from "./portfolio-movement.util";

/** A user's opted-in threshold and stored baseline, read for one evaluation. */
interface PortfolioStateRow {
  move_alert_percent: string | null;
  baseline_value: string | null;
  baseline_currency: string | null;
  baseline_captured_on: string | null;
}

/**
 * Daily notification of the market-driven change in a user's investment-account
 * value, net of external cash flows -- so a deposit does not fire a false gain
 * and a dividend is return, not a loss
 * (`docs/specs/portfolio-movement-notifications.md`).
 *
 * The measure is `MV(today) - MV(baseline) - externalFlow`: today's portfolio
 * value from `getPortfolioSummary` (holdings + cash, in the reporting currency,
 * with its own completeness flag), the last COMPLETE value the producer stored,
 * and the day's cash that crossed the investment-account boundary from outside.
 * A subtotal is never fired and never becomes a baseline (INV-PORTMOVE-001).
 *
 * Two things make the figure evidence rather than arithmetic. The flow is
 * converted at the date each amount crossed the boundary, never at the run's
 * date (INV-PORTMOVE-007), and a run in which a held position's latest close
 * predates the baseline is withheld, because that position's value is carried
 * from before the period and the day its price arrives would book the catch-up
 * as a market move (INV-PORTMOVE-008).
 *
 * The withhold policy and the arithmetic live in `decideMovement`
 * (`portfolio-movement.util.ts`), the flow conversion in `foldExternalFlow`
 * (`portfolio-flow.util.ts`) and the freshness rule in `stalePricedSecurityIds`
 * (`portfolio-price-freshness.util.ts`); all three are pure and unit-tested.
 * This service is the cron plumbing, the flow query and the baseline
 * read-modify-write.
 */
@Injectable()
export class PortfolioMovementAlertService {
  private readonly logger = new Logger(PortfolioMovementAlertService.name);
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly portfolio: PortfolioService,
    private readonly exchangeRates: ExchangeRateService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  /**
   * Daily on weekdays, after the security-price (5 PM ET), market-index
   * (5:10 PM ET) and GEM (5:30 PM ET) jobs, so today's value is priced.
   */
  @Cron("40 17 * * 1-5", { timeZone: "America/New_York" })
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const userIds = await withSystemContext(() =>
        withScopedDb(this.dataSource, async (manager) =>
          returnedRows<{ user_id: string }>(
            await manager.query(
              `SELECT user_id FROM notification_portfolio_state
                WHERE move_alert_percent IS NOT NULL AND move_alert_percent > 0`,
            ),
          ).map((row) => row.user_id),
        ),
      );

      let fired = 0;
      for (const userId of userIds) {
        try {
          const raised = await withUserContext(userId, () =>
            this.evaluateUser(userId),
          );
          if (raised) fired += 1;
        } catch (error) {
          this.logger.error(
            `Portfolio-movement evaluation failed for user ${userId}`,
            error instanceof Error ? error.stack : error,
          );
        }
      }
      if (fired > 0) {
        this.logger.log(`Raised ${fired} portfolio-movement alert(s)`);
      }
    } catch (error) {
      this.logger.error(
        "Portfolio-movement cron failed",
        error instanceof Error ? error.stack : error,
      );
    } finally {
      this.running = false;
    }
  }

  /** Evaluate one user; returns whether an alert was raised. */
  private async evaluateUser(userId: string): Promise<boolean> {
    const today = todayYMD();
    const currency = await this.reportingCurrency(userId);
    const summary = await this.portfolio.getPortfolioSummary(userId);
    const state = await this.loadState(userId);
    const movePercent =
      state?.move_alert_percent == null
        ? null
        : Number(state.move_alert_percent);

    const baseline =
      state?.baseline_value != null && state.baseline_currency != null
        ? {
            value: Number(state.baseline_value),
            currency: state.baseline_currency,
          }
        : null;

    // The flow and the price evidence only matter when there is a same-currency
    // baseline to measure a period against; otherwise the decision rebaselines
    // or withholds before reading either.
    const comparable =
      baseline != null &&
      baseline.currency === currency &&
      state?.baseline_captured_on != null &&
      summary.valuationComplete === true;
    const baselineDate = comparable
      ? (state!.baseline_captured_on as string)
      : null;

    const flow =
      baselineDate === null
        ? { complete: true, value: 0 }
        : await this.externalFlow(userId, baselineDate, today, currency);

    const stale =
      baselineDate === null
        ? []
        : await this.stalePricedHoldings(summary.holdings, baselineDate);
    if (stale.length > 0) {
      this.logger.warn(
        `Portfolio movement withheld for user ${userId}: ${stale.length} held ` +
          `position(s) priced before the ${baselineDate} baseline ` +
          `(${stale.join(", ")})`,
      );
    }

    const inputs: MovementInputs = {
      mvComplete: summary.valuationComplete === true,
      mvToday: summary.totalPortfolioValue,
      pricesCurrentSinceBaseline: stale.length === 0,
      currency,
      baseline,
      flow,
      movePercent,
    };
    const decision = decideMovement(inputs);

    if (decision.rebaselineTo != null) {
      await this.storeBaseline(userId, decision.rebaselineTo, currency, today);
    }
    if (decision.fire == null) return false;

    const prefs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const written = await this.dispatch.notify(
      userId,
      buildPortfolioNotification(
        decision.fire,
        currency,
        // `baselineDate` is non-null on every path that fires: a decision only
        // reaches `fire` through the comparable branch above.
        baselineDate ?? today,
        today,
        numberFormatterFor(prefs?.numberFormat, prefs?.language),
      ),
    );
    return written != null;
  }

  /**
   * The held securities whose latest accepted close predates `baselineDate`.
   *
   * The dates come from the very observations that priced today's value
   * (`PortfolioService.getLatestPriceObservations`, the dated form of the query
   * `getPortfolioSummary` values from), so this cannot disagree with the figure
   * it is vouching for. The policy is `stalePricedSecurityIds`
   * (INV-PORTMOVE-008).
   */
  private async stalePricedHoldings(
    holdings: readonly HeldPosition[],
    baselineDate: string,
  ): Promise<string[]> {
    const securityIds = [
      ...new Set(holdings.map((holding) => holding.securityId)),
    ];
    if (securityIds.length === 0) return [];
    const observations =
      await this.portfolio.getLatestPriceObservations(securityIds);
    return stalePricedSecurityIds(
      holdings,
      (securityId) => observations.get(securityId)?.date ?? null,
      baselineDate,
    );
  }

  /** The user's reporting currency, resolved through the one shared reader. */
  private async reportingCurrency(userId: string): Promise<string> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = returnedRows<{ default_currency: string | null }>(
        await manager.query(
          "SELECT default_currency FROM user_preferences WHERE user_id = $1",
          [userId],
        ),
      );
      return preferredCurrency({ defaultCurrency: rows[0]?.default_currency });
    });
  }

  private async loadState(userId: string): Promise<PortfolioStateRow | null> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = returnedRows<PortfolioStateRow>(
        await manager.query(
          `SELECT move_alert_percent, baseline_value, baseline_currency,
                  TO_CHAR(baseline_captured_on, 'YYYY-MM-DD') AS baseline_captured_on
             FROM notification_portfolio_state WHERE user_id = $1`,
          [userId],
        ),
      );
      return rows[0] ?? null;
    });
  }

  private async storeBaseline(
    userId: string,
    value: number,
    currency: string,
    capturedOn: string,
  ): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `INSERT INTO notification_portfolio_state
           (user_id, baseline_value, baseline_currency, baseline_captured_on)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE
           SET baseline_value = $2,
               baseline_currency = $3,
               baseline_captured_on = $4`,
        [userId, value, currency, capturedOn],
      ),
    );
  }

  /**
   * The net cash that crossed the investment-account boundary from outside since
   * `sinceDate` (exclusive) through `today` (inclusive), in `reportingCurrency`.
   *
   * Which rows count is `loadExternalFlowSubtotals`
   * (`securities/external-flow.util.ts`), shared with the calendar's daily
   * change layer so the two surfaces cannot measure different things under one
   * name; its doc comment carries the classification and the two coarse cases
   * (INV-PORTMOVE-006).
   *
   * What is this caller's own is the rate, and it is the flow's OWN date's, not
   * the day the cron runs (INV-PORTMOVE-007). The subtotals are read per day
   * and each `(date, currency)` pair is converted through the shared resolver
   * at that date, so a Friday deposit is worth Friday's rate on a Monday run;
   * pricing a weekend's flows at Monday's close moved the whole FX difference
   * into the movement and reported it as a market return. A `(date, currency)`
   * pair with no rate makes the flow incomplete -- which withholds the movement
   * rather than shrinking it (INV-PORTMOVE-002).
   */
  private async externalFlow(
    userId: string,
    sinceDate: string,
    today: string,
    reportingCurrency: string,
  ): Promise<{ complete: boolean; value: number }> {
    const subtotals = await loadExternalFlowSubtotals(
      (sql, params) =>
        withScopedDb(this.dataSource, (m) => m.query(sql, params)),
      { userId, afterDate: sinceDate, throughDate: today, perDay: true },
    );

    const flowRows: FlowSubtotal[] = subtotals.map((row) => ({
      date: row.date,
      currency: row.currency,
      amount: row.amount,
    }));

    // One resolution per (date, currency) pair, in historical mode: the rate
    // that applied on the day the cash crossed the boundary.
    const rates = new Map<string, number | null>();
    for (const { currency, date } of flowRows) {
      const on = date ?? today;
      const key = `${currency}@${on}`;
      if (rates.has(key)) continue;
      rates.set(
        key,
        currency === reportingCurrency
          ? 1
          : await this.exchangeRates.getRateForDate(
              currency,
              reportingCurrency,
              on,
            ),
      );
    }

    const folded = foldExternalFlow(
      flowRows,
      reportingCurrency,
      (currency, date) => rates.get(`${currency}@${date ?? today}`) ?? null,
    );
    if (!folded.complete) {
      this.logger.warn(
        `Portfolio movement withheld for user ${userId}: external flow has no ` +
          `rate for ${folded.missingPairs.join(", ")}`,
      );
    }
    return { complete: folded.complete, value: folded.value };
  }
}

/**
 * The notification a fired movement raises, as a pure function of the movement,
 * the reporting currency and the two dates it spans -- so the type/severity,
 * deep link and `data` snapshot are testable without the cron. Dedupe key
 * carries the day, so at most one movement alert exists per day.
 *
 * The payload names what was measured and over which period, because a figure a
 * reader cannot reproduce is a figure they have to trust: both boundary dates
 * and all three components (`baselineValue`, `currentValue`, `externalFlow`) in
 * the one currency. "Today" alone was wrong as often as it was right -- a Monday
 * run measures from Friday -- so the copy names the period rather than the day.
 */
export function buildPortfolioNotification(
  fire: FiredMovement,
  currency: string,
  baselineDate: string,
  today: string,
  n: NumberT = defaultNumberT,
): CreateNotificationInput {
  const percent = n.formatPercentTrimmed(Math.abs(fire.changePercent));
  const moved = fire.direction === "up" ? "up" : "down";
  return {
    type: NotificationType.PORTFOLIO_MOVEMENT,
    severity: NotificationSeverity.INFO,
    title: "Investment value moved",
    message:
      `Your investments are ${moved} ${percent} from ${baselineDate} to ` +
      `${today} (excluding deposits and withdrawals). Open Monize for the details.`,
    data: {
      changePercent: fire.changePercent,
      direction: fire.direction,
      movementValue: fire.movementValue,
      baselineValue: fire.baselineValue,
      currentValue: fire.currentValue,
      externalFlow: fire.externalFlow,
      baselineDate,
      valuationDate: today,
      currencyCode: currency,
    },
    target: "/investments",
    dedupeKey: `portmove:${currency}:${today}`,
  };
}
