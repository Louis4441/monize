import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { loadBondLedger, loadLinkedSecurity } from "./bond-ledger";
import { bondLotsAsOf } from "./bond-lots";
import { inferSeriesForDate, seriesCodeOf } from "./bond-series-resolver";
import { lotsRefusalException } from "./bond-write-guard";

/** The series the server would infer for an acquisition on a date. */
export interface SeriesOnSale {
  readonly instrumentId: string;
  readonly seriesCode: string;
}

/** A series an account holds on a date. */
export interface SeriesHolding {
  readonly instrumentId: string;
  readonly seriesCode: string;
  /** A whole number of bonds, greater than zero. */
  readonly quantity: number;
}

/**
 * What the transaction form asks the server before it writes
 * (`docs/specs/bond-program-securities.md` section 3.3): the series a BUY on a
 * date would be given, and the series an account holds, so a removal can name
 * one. Both are read through the code the write itself uses -- `seriesOnSaleSql`
 * and the lot derivation -- so the form never offers what the write would refuse.
 * Owner-scoped: `userId` comes from the JWT, and another user's security answers
 * 404 exactly as an unlinked one does.
 */
@Injectable()
export class BondHoldingsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * The series `resolveTransactionSeries` would store for a BUY or REINVEST on
   * `date` (the one series of the program whose newest terms' sale window
   * contains it), or null when none, or more than one, is on sale.
   */
  async seriesOnSale(
    userId: string,
    securityId: string,
    date: string,
  ): Promise<SeriesOnSale | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const security = await loadLinkedSecurity(m, userId, securityId);
      const instrumentId = await inferSeriesForDate(
        m,
        security.bondProgramId,
        date,
      );
      if (instrumentId === null) return null;
      const seriesCode = await seriesCodeOf(m, instrumentId);
      return seriesCode === null ? null : { instrumentId, seriesCode };
    });
  }

  /**
   * The series `accountId` holds on `date`: the lot derivation over the rows up
   * to and including that day, in replay order, excluding
   * `excludeTransactionId` (the row being edited), oldest lot first, quantity
   * above zero only. A ledger whose lots cannot be derived answers 422 with the
   * refusal code as `errorCode`.
   */
  async seriesHoldings(
    userId: string,
    securityId: string,
    accountId: string,
    date: string,
    excludeTransactionId?: string,
  ): Promise<{ holdings: SeriesHolding[] }> {
    return withScopedDb(this.dataSource, async (m) => {
      const ledger = await loadBondLedger(m, userId, securityId);
      const rows = ledger.transactions.filter(
        (row) => row.id === undefined || row.id !== excludeTransactionId,
      );
      const { lots, refusal } = bondLotsAsOf(rows, date);
      if (refusal !== null) throw lotsRefusalException(refusal, "read");

      const quantities = new Map<string, number>();
      for (const lot of lots) {
        if (lot.accountId !== accountId || lot.instrumentId === null) continue;
        quantities.set(
          lot.instrumentId,
          (quantities.get(lot.instrumentId) ?? 0) + lot.quantity,
        );
      }

      const holdings: SeriesHolding[] = [];
      for (const [instrumentId, quantity] of quantities) {
        if (quantity <= 0) continue;
        const seriesCode = await seriesCodeOf(m, instrumentId);
        if (seriesCode !== null) {
          holdings.push({ instrumentId, seriesCode, quantity });
        }
      }
      return { holdings };
    });
  }
}
