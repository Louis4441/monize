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
import { tr } from "../i18n/translate";
import {
  ExchangeRateService,
  directionlessPairKey,
} from "./exchange-rate.service";

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
 * The outcome of one "add another year" request.
 *
 * `requestedFrom`/`requestedTo` are the window that was asked for, `stored` the
 * number of days the provider actually answered with, and `earliestDate` the
 * coverage's new lower bound. `answered: true` always here: a provider that did
 * not answer is a 503, not a zero (see `extendHistory`).
 */
export interface RateHistoryExtension {
  from: string;
  to: string;
  requestedFrom: string;
  requestedTo: string;
  stored: number;
  earliestDate: string | null;
  answered: boolean;
}

/**
 * The calendar day one year before `ymd`, clamped to the end of the month.
 *
 * Calendar arithmetic rather than 365 days, because the unit a person asked for
 * is "a year" and a leap year has 366 of them. February 29 has no counterpart a
 * year earlier, so it clamps to February 28 -- the alternative, letting
 * `Date.UTC(y - 1, 1, 29)` roll into March 1, would leave the two days between
 * the new window's end and the old coverage's start unfetched forever, because
 * the next extension starts from the *stored* earliest date.
 *
 * Deliberately not a local-midnight `Date` read back with `toISOString()`: the
 * input carries no time and no zone, and west of Greenwich that round trip
 * names the previous day.
 */
export function oneYearEarlierYMD(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const target = year - 1;
  const daysInMonth = new Date(Date.UTC(target, month, 0)).getUTCDate();
  const clamped = Math.min(day, daysInMonth);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${target}-${p(month)}-${p(clamped)}`;
}

/**
 * Extending the stored FX history of one pair backwards, a year at a time.
 *
 * The daily refresh writes today and `backfillHistoricalRates` skips any pair
 * that already has a row, so a pair's stored history usually begins on the day
 * the cron first ran. A report dated before that says "Missing exchange rates:
 * EUR->PLN 2026-01-01 to 2026-06-19" and there is nothing the reader can do
 * about it without admin rights. This is that door: read what is stored, ask
 * the provider for the year before it, keep what comes back.
 *
 * It is a sibling of `ExchangeRateService` rather than more of it because that
 * file is already past this repository's size ceiling; the provider call itself
 * is that service's `fillRateWindow`, reached through its public wrapper, so
 * there is exactly one place that talks to Yahoo about a rate window.
 *
 * **Concurrency.** The write is an idempotent upsert on the natural key
 * `(from_currency, to_currency, rate_date)` -- mechanism 4 of
 * `docs/concurrency-and-idempotency.md` -- so two concurrent extensions of the
 * same pair converge rather than duplicate, and correctness needs nothing else.
 * `inFlight` below is therefore a *coalescer, not a guard*: it exists only so a
 * double-clicked button costs one provider call instead of two, and a replica
 * that has not seen the first click simply makes the call. It gates no row and
 * coordinates nothing across replicas, which is the same category as
 * `EmptyWindowMemory`.
 */
@Injectable()
export class ExchangeRateHistoryService {
  private readonly logger = new Logger(ExchangeRateHistoryService.name);

  /** Extensions currently running, keyed by directionless pair. See the class doc. */
  private readonly inFlight = new Map<string, Promise<RateHistoryExtension>>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly exchangeRateService: ExchangeRateService,
  ) {}

  /**
   * The pair `code` forms with the caller's reporting currency, and the two
   * currencies in the order the rest of the UI names them.
   *
   * Refuses the same-currency pair: 1 is not a stored rate and there is no
   * history to extend.
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
          `${code} is your default currency; there is no exchange rate history to extend`,
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
   * Fetch and store the year of daily rates immediately before what is stored.
   *
   * The window is `[earliest - 1 year, earliest - 1 day]`, so it abuts the
   * stored history without overlapping it; with nothing stored it is the year
   * ending yesterday, today being the cron's own territory.
   *
   * Three outcomes, and the caller has to be able to tell them apart:
   * the provider answered with rates (`stored > 0`), the provider answered with
   * nothing (`stored === 0` -- this pair has no history that far back, and
   * asking again will not change that), or the provider did not answer at all
   * (a transport failure or a call the breaker refused), which is a 503 so the
   * UI can say "try later" rather than "there is no older data".
   */
  async extendHistory(
    userId: string,
    code: string,
  ): Promise<RateHistoryExtension> {
    const { from, to } = await this.resolvePair(userId, code);
    const key = directionlessPairKey(from, to);
    const running = this.inFlight.get(key);
    if (running) return running;

    const attempt = this.runExtension(userId, from, to).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, attempt);
    return attempt;
  }

  private async runExtension(
    userId: string,
    from: string,
    to: string,
  ): Promise<RateHistoryExtension> {
    const before = await this.readCoverage(from, to);
    // No rows at all: there is nothing to extend backwards from, so the year
    // ending yesterday is what the reader means by "another year".
    const anchor = before.earliestDate ?? todayYMD();
    const requestedFrom = oneYearEarlierYMD(anchor);
    const requestedTo = addDaysYMD(anchor, -1);

    // `exchange_rates` is shared reference data (it is RLS-exempt for that
    // reason), so the user id goes in the log line rather than in the row.
    this.logger.log(
      `User ${userId} extending ${from}->${to} rate history over ${requestedFrom} to ${requestedTo}`,
    );

    const { stored, answered } = await this.exchangeRateService.fillRateWindow(
      from,
      to,
      requestedFrom,
      requestedTo,
    );

    if (!answered) {
      this.logger.warn(
        `Rate history extension ${from}->${to} over ${requestedFrom} to ${requestedTo} got no answer from the provider`,
      );
      throw new ServiceUnavailableException(
        tr(
          "errors.currencies.rateProviderUnavailable",
          "The exchange rate provider did not answer. Please try again later.",
        ),
      );
    }

    const after = stored > 0 ? await this.readCoverage(from, to) : before;
    return {
      from,
      to,
      requestedFrom,
      requestedTo,
      stored,
      earliestDate: after.earliestDate,
      answered,
    };
  }
}
