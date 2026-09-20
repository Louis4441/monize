import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { addDaysYMD, todayYMD } from "../common/date-utils";
import { resolveUserDefaultCurrency } from "../common/default-currency.util";
import { withScopedDb } from "../common/db/scoped-db";
import { roundFxRate } from "../common/fx-entry.util";
import { EmptyWindowMemory } from "../common/time-series/history-fill";
import { FX_MAX_RATE_AGE_DAYS } from "../common/time-series/fx-rate-resolver";
import { investmentEffectStatusSql } from "../securities/investment-row-effects.util";
import { tr } from "../i18n/translate";
import {
  ExchangeRateService,
  directionlessPairKey,
} from "./exchange-rate.service";
import {
  GAP_FILL_BUDGET_MS,
  planRateGapWindows,
  type RateGapWindow,
} from "./rate-gap-plan";

/**
 * What the database already holds for one currency pair, in days.
 *
 * `earliestDate` and `latestDate` are `YYYY-MM-DD` or `null` when the pair has
 * no rows at all; `observations` counts calendar days, not rows. Rows written
 * before the pair was collapsed to one orientation still hold a day twice, and a
 * reader shown "512 observations" for 256 days would read that storage layout as
 * market data.
 */
export interface RateCoverage {
  from: string;
  to: string;
  earliestDate: string | null;
  latestDate: string | null;
  observations: number;
}

/**
 * The most dates one listing returns, newest first.
 *
 * Roughly eight years of daily observations. The listing is a scrollable panel
 * in a dialog, not an export, so it is bounded; what the bound leaves out is
 * reported (`truncated`) rather than quietly dropped, and `getCoverage` still
 * answers over every stored row, so the span a reader is told about is never
 * the capped one.
 */
export const STORED_RATE_ROW_CAP = 2000;

/** One stored observation, stated in the direction the reader asked about. */
export interface StoredRate {
  /** `YYYY-MM-DD`, through `TO_CHAR` rather than the DATE parser. */
  rateDate: string;
  /**
   * Units of `to` per 1 unit of `from`, or `null` where the stored row cannot
   * be stated in that direction at all: a row holding zero or a negative rate
   * inverts to infinity, which is an unknown, never a rate and never a zero.
   */
  rate: number | null;
  /** The provider slug the row carries; `null` for a row written without one. */
  source: string | null;
  /** The stored row is the other orientation and `rate` is its reciprocal. */
  inverted: boolean;
}

export interface StoredRateList {
  from: string;
  to: string;
  /** Newest date first, one entry per date. */
  rates: StoredRate[];
  /** The pair holds more dates than `limit`; the oldest are not listed. */
  truncated: boolean;
  limit: number;
}

/**
 * The outcome of one "fill the gaps" request.
 *
 * `usedFrom` is the first date the currency appears in the caller's own data
 * and `null` when it appears nowhere, which is the one case that fetches
 * nothing at all. The window counts add up: `windowsPlanned` is
 * `windowsFetched` plus `windowsSkipped` plus `windowsRemaining`, where skipped
 * means the provider already answered that window with nothing and remaining
 * means the per-request bound stopped before it.
 */
export interface RateGapFill {
  from: string;
  to: string;
  usedFrom: string | null;
  /** Today; the span the fill considers is `[usedFrom, spanEnd]`. */
  spanEnd: string;
  /** Calendar days in the span no stored observation could answer. */
  unresolvableDays: number;
  windowsPlanned: number;
  windowsFetched: number;
  windowsSkipped: number;
  /** Fetched windows the provider did not answer at all. */
  windowsUnanswered: number;
  windowsRemaining: number;
  /** Observations persisted by this request. */
  stored: number;
  /** The pair's new coverage lower bound. */
  earliestDate: string | null;
  /**
   * The provider answered the oldest window with no rates, so it carries
   * nothing before this date. A statement about the provider's history, not
   * about a failure: asking again will not change it.
   */
  providerHasNothingBefore: string | null;
}

/**
 * Reading and deepening the stored FX history of one pair.
 *
 * The daily refresh writes today's spot rate and `backfillHistoricalRates`
 * skips any pair that already holds a row, so a pair's stored history usually
 * begins on the day the cron first ran. A report dated before that says
 * "Missing exchange rates: EUR->PLN 2026-01-01 to 2026-06-19" and there is
 * nothing the reader can do about it without admin rights. This is that door:
 * list what is stored, work out which dates no stored observation can answer,
 * and ask the provider for those.
 *
 * It is a sibling of `ExchangeRateService` rather than more of it because that
 * file is already past this repository's size ceiling; the provider call itself
 * is that service's `fillRateWindow`, reached through its public wrapper, so
 * there is exactly one place that talks to Yahoo about a rate window.
 *
 * **Concurrency.** The write is an idempotent upsert on the natural key
 * `(from_currency, to_currency, rate_date)` -- mechanism 4 of
 * `docs/concurrency-and-idempotency.md` -- so two concurrent fills of the same
 * pair converge rather than duplicate, and correctness needs nothing else.
 * `inFlight` below is therefore a *coalescer, not a guard*: it exists only so a
 * double-clicked button costs one provider call instead of two, and a replica
 * that has not seen the first click simply makes the call. It gates no row and
 * coordinates nothing across replicas, which is the same category as
 * `emptyWindows` beside it.
 *
 * `docs/specs/fx-history-gap-fill.md` is the contract.
 */
@Injectable()
export class ExchangeRateHistoryService {
  private readonly logger = new Logger(ExchangeRateHistoryService.name);

  /**
   * Fills currently running, keyed by caller and directionless pair.
   *
   * The caller is part of the key because the answer is about their data: the
   * span comes from their own accounts and the counts describe their gaps. Two
   * people sharing a reporting currency who press at the same moment would
   * otherwise both be handed the first one's `usedFrom` and a
   * `windowsRemaining: 0` that was never computed for the second. See the class
   * doc for why this coalesces rather than guards.
   */
  private readonly inFlight = new Map<string, Promise<RateGapFill>>();

  /**
   * Windows the provider answered with no rates, remembered for half an hour.
   *
   * A pair's history starts where it starts, so the window before it can never
   * be filled; without this, every press of the button re-asks for it. A cache
   * and not a guard, in the category `history-fill.ts` describes: losing an
   * entry costs a round trip and changes no row.
   */
  private readonly emptyWindows = new EmptyWindowMemory();

  constructor(
    private readonly dataSource: DataSource,
    private readonly exchangeRateService: ExchangeRateService,
  ) {}

  /**
   * The pair `code` forms with the caller's reporting currency, and the two
   * currencies in the order the rest of the UI names them.
   *
   * Refuses the same-currency pair: 1 is not a stored rate, so there is no
   * history to list and none to fill.
   */
  private async resolvePair(
    userId: string,
    code: string,
  ): Promise<{ from: string; to: string }> {
    const to = await resolveUserDefaultCurrency(this.dataSource, userId);
    if (code === to) {
      throw new BadRequestException(
        tr(
          "errors.currencies.sameCurrencyHistory",
          `${code} is your default currency; it has no exchange rate history`,
          { code },
        ),
      );
    }
    return { from: code, to };
  }

  /**
   * What is stored for `code` against the caller's reporting currency.
   *
   * Either stored direction counts as the one pair it is: a row under
   * `PLN->EUR` is evidence about `EUR->PLN` on that date too, which is why a new
   * row is stored in one orientation only (INV-FX-003) and why this still reads
   * both -- rows written before that change are still there. Dates come back
   * through `TO_CHAR` rather than the entity transformer, per the backend's
   * raw-SELECT rule.
   */
  async getCoverage(userId: string, code: string): Promise<RateCoverage> {
    const { from, to } = await this.resolvePair(userId, code);
    return this.readCoverage(from, to);
  }

  private async readCoverage(from: string, to: string): Promise<RateCoverage> {
    const rows: Array<{
      earliest: string | null;
      latest: string | null;
      observations: string | null;
    }> = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT TO_CHAR(MIN(rate_date), 'YYYY-MM-DD') AS earliest,
                TO_CHAR(MAX(rate_date), 'YYYY-MM-DD') AS latest,
                COUNT(DISTINCT rate_date) AS observations
           FROM exchange_rates
          WHERE (from_currency = $1 AND to_currency = $2)
             OR (from_currency = $2 AND to_currency = $1)`,
        [from, to],
      ),
    );
    const row = rows[0];
    return {
      from,
      to,
      earliestDate: row?.earliest ?? null,
      latestDate: row?.latest ?? null,
      observations: Number(row?.observations ?? 0),
    };
  }

  /**
   * Every stored rate for `code` against the caller's reporting currency,
   * newest date first, one entry per date.
   *
   * One entry per date is structural rather than a property of an ordering:
   * the rows are grouped by date and each group yields the canonical
   * orientation's row, which is the one every writer maintains and the one the
   * pending contract migration keeps where a pre-collapse date is held twice
   * and the two disagree. Grouping also keeps this off the newest-rate path
   * that `fx-rate.one-door.spec.ts` guards; this is a listing, not a lookup,
   * and a date's rate for a calculation still comes from `resolveFxRate`.
   */
  async getStoredRates(userId: string, code: string): Promise<StoredRateList> {
    const { from, to } = await this.resolvePair(userId, code);

    const rows: Array<{
      rate_date: string;
      from_currency: string;
      rate: string | null;
      source: string | null;
    }> = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT TO_CHAR(rate_date, 'YYYY-MM-DD') AS rate_date,
                (ARRAY_AGG(from_currency ORDER BY (from_currency < to_currency) DESC, id DESC))[1] AS from_currency,
                (ARRAY_AGG(rate ORDER BY (from_currency < to_currency) DESC, id DESC))[1] AS rate,
                (ARRAY_AGG(source ORDER BY (from_currency < to_currency) DESC, id DESC))[1] AS source
           FROM exchange_rates
          WHERE (from_currency = $1 AND to_currency = $2)
             OR (from_currency = $2 AND to_currency = $1)
          GROUP BY rate_date
          ORDER BY rate_date DESC
          LIMIT $3`,
        [from, to, STORED_RATE_ROW_CAP + 1],
      ),
    );

    const rates = rows.slice(0, STORED_RATE_ROW_CAP).map((row) => {
      const stored = Number(row.rate);
      const inverted = row.from_currency !== from;
      const usable = Number.isFinite(stored) && stored > 0;
      return {
        rateDate: row.rate_date,
        // The reciprocal is struck at the rate column's ten decimals, never at
        // money's four: `canonicalRateRow` inverts the same way, so a row read
        // back matches the row a fetch would have written.
        rate: usable ? (inverted ? roundFxRate(1 / stored) : stored) : null,
        source: row.source ?? null,
        inverted,
      };
    });

    return {
      from,
      to,
      rates,
      truncated: rows.length > STORED_RATE_ROW_CAP,
      limit: STORED_RATE_ROW_CAP,
    };
  }

  /**
   * The first date `code` appears in this user's own data, or `null`.
   *
   * Deliberately wider than `backfillHistoricalRates`' discovery, which filters
   * to open accounts, active securities and non-empty holdings because it is
   * priming rates for current positions. A history fill must include the years
   * a since-closed account was open and a since-sold holding was held, because
   * "net worth over time" and "portfolio value over time" still report them.
   *
   * An account or security with no postings still falls back to the row's own
   * creation date rather than dropping out: an account holding an opening
   * balance and nothing else is still reported by "net worth over time", and
   * answering "nothing of yours uses EUR" for one would leave a reader with no
   * way to fetch the rates their own balances need. The same fallback
   * `resolveInvestmentInception` uses for an account with neither ledger.
   *
   * Rows as EFFECTS: renders `it.status != 'VOID'`, because a void posting
   * records something that did not happen and so dates no use of the currency.
   *
   * `null` means no account and no security of this user's is denominated in
   * the currency, so no report of theirs can need the rate.
   */
  private async firstUseOfCurrency(
    userId: string,
    code: string,
  ): Promise<string | null> {
    // Rows as EFFECTS: both postings subqueries below render
    // `status != 'VOID'`, because a void row records something that did not
    // happen and so dates no use of the currency.
    const rows: Array<{ earliest: string | null }> = await withScopedDb(
      this.dataSource,
      (manager) =>
        manager.query(
          `SELECT TO_CHAR(MIN(earliest), 'YYYY-MM-DD') AS earliest
             FROM (
               SELECT COALESCE(
                        LEAST(
                          (SELECT MIN(t.transaction_date)
                             FROM transactions t
                            WHERE t.account_id = a.id),
                          (SELECT MIN(it.transaction_date)
                             FROM investment_transactions it
                            WHERE it.account_id = a.id
                              AND ${investmentEffectStatusSql("it")})
                        ),
                        a.created_at::DATE
                      ) AS earliest
                 FROM accounts a
                WHERE a.user_id = $1
                  AND a.currency_code = $2
               UNION ALL
               -- Rows as EFFECTS here too: status != 'VOID'.
               SELECT COALESCE(
                        (SELECT MIN(it.transaction_date)
                           FROM investment_transactions it
                          WHERE it.security_id = s.id
                            AND ${investmentEffectStatusSql("it")}),
                        s.created_at::DATE
                      ) AS earliest
                 FROM securities s
                WHERE s.user_id = $1
                  AND s.currency_code = $2
             ) uses`,
          [userId, code],
        ),
    );
    return rows[0]?.earliest ?? null;
  }

  /**
   * The pair's observation dates from `from` onwards, in either orientation.
   *
   * The caller asks from `FX_MAX_RATE_AGE_DAYS` before the span, because an
   * observation that far ahead of the span's first day is what answers it.
   *
   * A non-positive stored rate is not an observation: `resolveFxRate` discards
   * it, so counting it here would plan no gap over the 45 days it appears to
   * cover while every report over them still refuses to convert.
   */
  private async storedDatesFrom(
    from: string,
    to: string,
    start: string,
    end: string,
  ): Promise<string[]> {
    const rows: Array<{ rate_date: string }> = await withScopedDb(
      this.dataSource,
      (manager) =>
        manager.query(
          `SELECT DISTINCT TO_CHAR(rate_date, 'YYYY-MM-DD') AS rate_date
             FROM exchange_rates
            WHERE ((from_currency = $1 AND to_currency = $2)
                OR (from_currency = $2 AND to_currency = $1))
              AND rate > 0
              AND rate_date >= $3::DATE
              AND rate_date <= $4::DATE`,
          [from, to, start, end],
        ),
    );
    return rows.map((row) => row.rate_date);
  }

  /**
   * Fetch and store the rates the caller's reports are short of, for one pair.
   *
   * The span is the first date the currency is used through today, and the work
   * is the windows inside it that no stored observation can answer -- not the
   * whole span, because a fetched window overwrites every row it covers.
   *
   * Three outcomes the caller has to be able to tell apart: rates were stored;
   * the provider answered with nothing, which is a statement about its history
   * and will not change on a retry; or the provider did not answer, which is a
   * 503 so the UI can say "try later" rather than "there is no data".
   */
  async fillRateGaps(userId: string, code: string): Promise<RateGapFill> {
    const { from, to } = await this.resolvePair(userId, code);
    const key = `${userId}|${directionlessPairKey(from, to)}`;
    const running = this.inFlight.get(key);
    if (running) return running;

    const attempt = this.runGapFill(userId, from, to).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, attempt);
    return attempt;
  }

  private async runGapFill(
    userId: string,
    from: string,
    to: string,
  ): Promise<RateGapFill> {
    const spanEnd = todayYMD();
    const usedFrom = await this.firstUseOfCurrency(userId, from);
    const before = await this.readCoverage(from, to);

    const nothingToDo = (extra: Partial<RateGapFill> = {}): RateGapFill => ({
      from,
      to,
      usedFrom,
      spanEnd,
      unresolvableDays: 0,
      windowsPlanned: 0,
      windowsFetched: 0,
      windowsSkipped: 0,
      windowsUnanswered: 0,
      windowsRemaining: 0,
      stored: 0,
      earliestDate: before.earliestDate,
      providerHasNothingBefore: null,
      ...extra,
    });

    // Nothing of this user's is denominated in the currency, so no report of
    // theirs needs the rate. Fetching a history nobody reads is the cost this
    // check exists to avoid.
    if (!usedFrom) return nothingToDo();
    if (usedFrom > spanEnd) return nothingToDo();

    const stored = await this.storedDatesFrom(
      from,
      to,
      addDaysYMD(usedFrom, -FX_MAX_RATE_AGE_DAYS),
      spanEnd,
    );
    const plan = planRateGapWindows(stored, usedFrom, spanEnd);
    if (plan.windows.length === 0) {
      return nothingToDo({
        unresolvableDays: plan.unresolvableDays,
        windowsRemaining: plan.remainingWindows,
      });
    }

    // `exchange_rates` is shared reference data (it is RLS-exempt for that
    // reason), so the user id goes in the log line rather than in the row.
    this.logger.log(
      `User ${userId} filling ${plan.windows.length} ${from}->${to} rate gap window(s) ` +
        `over ${usedFrom} to ${spanEnd} (${plan.unresolvableDays} unanswerable days)`,
    );

    const outcome = await this.fetchWindows(from, to, plan.windows);

    if (
      outcome.fetched > 0 &&
      outcome.unanswered === outcome.fetched &&
      outcome.stored === 0
    ) {
      // Every window this request actually asked for failed to answer, and
      // nothing was written: that is an outage, not an absence. A request that
      // asked for nothing -- because every window is already known empty -- is
      // neither, and says so with its counts.
      this.logger.warn(
        `Rate gap fill ${from}->${to} got no answer from the provider`,
      );
      throw new ServiceUnavailableException(
        tr(
          "errors.currencies.rateProviderUnavailable",
          "The exchange rate provider did not answer. Please try again later.",
        ),
      );
    }

    const after =
      outcome.stored > 0 ? await this.readCoverage(from, to) : before;

    return {
      from,
      to,
      usedFrom,
      spanEnd,
      unresolvableDays: plan.unresolvableDays,
      windowsPlanned: plan.windows.length + plan.remainingWindows,
      windowsFetched: outcome.fetched,
      windowsSkipped: outcome.skipped,
      windowsUnanswered: outcome.unanswered,
      // A window the provider did not answer is still to do, exactly like one
      // the bound never reached: the reader is told to press again rather than
      // being shown a total that silently dropped it.
      windowsRemaining:
        plan.remainingWindows +
        (plan.windows.length - outcome.attempted) +
        outcome.unanswered,
      stored: outcome.stored,
      earliestDate: after.earliestDate,
      providerHasNothingBefore: outcome.providerHasNothingBefore,
    };
  }

  /**
   * Ask the provider for each window in turn, stopping at the time budget.
   *
   * Sequential on purpose, for two recorded reasons. A burst of windows fired
   * from inside one HTTP request is what rate-limits everybody
   * (`net-worth/series-rate-fill.ts`). And only one concurrent call can hold
   * the circuit breaker's half-open probe, so parallel windows are refused and
   * read as empty history (`securities/market-index.service.ts`).
   */
  private async fetchWindows(
    from: string,
    to: string,
    windows: readonly RateGapWindow[],
  ): Promise<{
    attempted: number;
    fetched: number;
    skipped: number;
    unanswered: number;
    stored: number;
    providerHasNothingBefore: string | null;
  }> {
    const key = directionlessPairKey(from, to);
    const deadline = Date.now() + GAP_FILL_BUDGET_MS;

    let attempted = 0;
    let fetched = 0;
    let skipped = 0;
    let unanswered = 0;
    let stored = 0;
    let providerHasNothingBefore: string | null = null;

    for (const [index, window] of windows.entries()) {
      if (Date.now() >= deadline) break;
      attempted++;

      const subject = `${window.start}..${window.end}`;
      if (this.emptyWindows.has(key, subject)) {
        skipped++;
        // Known empty because the provider said so, so the reader is told the
        // same thing this run as last run: a second press that reported
        // nothing would read as a failure rather than as a history that
        // starts where it starts.
        if (index === 0) {
          providerHasNothingBefore = addDaysYMD(window.end, 1);
        }
        continue;
      }

      const result = await this.exchangeRateService.fillRateWindow(
        from,
        to,
        window.start,
        window.end,
      );
      fetched++;
      stored += result.stored;

      if (!result.answered) {
        unanswered++;
        continue;
      }
      if (result.stored === 0) {
        // The provider answered and had nothing here. Remember it so pressing
        // the button again does not re-ask, and where this is the oldest
        // window, say so: a pair's history starts where it starts.
        this.emptyWindows.remember(key, subject);
        this.logger.warn(
          `No rates available for ${from}/${to} over ${window.start} to ${window.end}`,
        );
        if (index === 0) {
          providerHasNothingBefore = addDaysYMD(window.end, 1);
        }
      }
    }

    return {
      attempted,
      fetched,
      skipped,
      unanswered,
      stored,
      providerHasNothingBefore,
    };
  }
}
