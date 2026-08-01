import { Injectable, Logger } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import { Security } from "../securities/entities/security.entity";
import { SecurityPriceService } from "../securities/security-price.service";
import { GemPriceService } from "./gem-price.service";
import { GemCadence } from "./entities/gem-strategy.entity";
import { cadenceMonths } from "./gem-momentum.util";
import { GEM_HISTORY_PERIODS } from "./gem-signal.service";

/**
 * Do not ask the quote provider for the same security again within this window.
 * A symbol the provider has no data for would otherwise be re-fetched on every
 * configuration save.
 */
const BACKFILL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Months of history the report wants: the momentum window plus the span the
 * signal history table covers. That span is measured in *periods*, so a
 * quarterly strategy needs three times the months a monthly one does -- reading
 * the periods as months would leave its oldest evaluations permanently
 * unpriced, and re-attempted on every read.
 */
function requiredMonths(lookbackMonths: number, cadence: GemCadence): number {
  return lookbackMonths + GEM_HISTORY_PERIODS * cadenceMonths(cadence);
}

/** Provider range that covers `months`, from the ranges the providers accept. */
function rangeFor(months: number): string {
  if (months <= 12) return "1y";
  if (months <= 60) return "5y";
  if (months <= 120) return "10y";
  return "max";
}

/** ISO date `months` before today. */
function monthsAgo(months: number): string {
  const today = new Date(`${todayYMD()}T00:00:00Z`);
  today.setUTCMonth(today.getUTCMonth() - months);
  return today.toISOString().slice(0, 10);
}

/**
 * Fetches the price history a freshly configured GEM strategy is missing.
 *
 * Assigning an instrument to a role is the moment the strategy becomes able to
 * produce a signal -- but a security the user has just created carries no
 * prices yet, and momentum cannot be computed from nothing. Rather than leave
 * the first signal to appear whenever the background backfill happens to land,
 * the configuration save pulls the history in and then evaluates.
 */
@Injectable()
export class GemBackfillService {
  private readonly logger = new Logger(GemBackfillService.name);

  constructor(
    private dataSource: DataSource,
    private priceService: GemPriceService,
    private securityPriceService: SecurityPriceService,
  ) {}

  /**
   * Ensure every given security has prices reaching back far enough for the
   * strategy, fetching what is missing. Returns the securities it fetched for.
   *
   * A provider failure is logged, not thrown: the report renders its
   * incomplete-history warning, which is a better outcome than a save that
   * appears to have failed.
   */
  async ensureHistory(
    userId: string,
    securityIds: string[],
    lookbackMonths: number,
    cadence: GemCadence,
  ): Promise<string[]> {
    const wanted = [...new Set(securityIds)];
    if (wanted.length === 0) return [];

    const months = requiredMonths(lookbackMonths, cadence);
    const needFrom = monthsAgo(months);
    const earliest = await this.priceService.earliestPriceDates(wanted);
    const short = wanted.filter((id) => {
      const from = earliest.get(id);
      return !from || from > needFrom;
    });
    if (short.length === 0) return [];

    const securities = await withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(Security)
        .find({ where: { id: In(short), userId } }),
    );
    const now = Date.now();
    const due = securities.filter((security) => {
      const last = security.historicalBackfillAttemptedAt;
      if (!last) return true;
      const lastMs =
        last instanceof Date ? last.getTime() : Date.parse(String(last));
      return !Number.isFinite(lastMs) || now - lastMs > BACKFILL_COOLDOWN_MS;
    });
    if (due.length === 0) return [];

    const range = rangeFor(months);
    await Promise.all(
      due.map((security) =>
        this.securityPriceService
          .backfillSecurityRange(security, range)
          .catch((error: unknown) => {
            this.logger.warn(
              `GEM history backfill failed for ${security.symbol}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return 0;
          }),
      ),
    );

    // Stamp every attempt, successful or not: the cooldown exists to spare the
    // provider, not to record whether the data improved.
    await withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(Security)
        .update(
          { id: In(due.map((security) => security.id)) },
          { historicalBackfillAttemptedAt: new Date() },
        ),
    );

    return due.map((security) => security.id);
  }
}
