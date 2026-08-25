import {
  Injectable,
  NotFoundException,
  forwardRef,
  Inject,
} from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { Account } from "./entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "../scheduled-transactions/entities/scheduled-transaction-override.entity";
import {
  ScheduledEffectiveAmountService,
  overrideEffectiveKey,
} from "../scheduled-transactions/scheduled-effective-amount.service";
import {
  BalanceForecastGap,
  ForecastOverrideInput,
  ForecastPoint,
  ForecastScheduleInput,
  accumulateForecastDeltas,
  addDaysYMD,
  buildForecastSeries,
} from "./balance-forecast.util";
import { roundMoney } from "../common/round.util";
import { todayYMD } from "../common/date-utils";
import { ensureYMD } from "../common/recurrence";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";

export interface BalanceForecastResult {
  accountId: string;
  currencyCode: string;
  /**
   * The projected series. When `complete` is false this holds only today's
   * anchor -- a running balance is cumulative, so one occurrence nobody can
   * price makes every point after it wrong, and a plausible line is worse than
   * no line (`docs/financial-semantics.md`, issue #1247).
   */
  points: ForecastPoint[];
  /** False when any occurrence inside the horizon could not be priced. */
  complete: boolean;
  /** The schedules that made it incomplete, so the client can say which and why. */
  gaps: BalanceForecastGap[];
}

/**
 * Projects an account's balance forward from today, applying future-dated real
 * transactions and expanded scheduled-transaction occurrences. Complements the
 * historical daily-balances series, which only reflects real transactions.
 */
@Injectable()
export class BalanceForecastService {
  constructor(
    private readonly dataSource: DataSource,
    // What each occurrence would post today, and which account pays for it, from
    // the one server-side resolver (issue #1247). Both halves matter here: a
    // scheduled investment's `accountId` is the brokerage while its cash settles
    // elsewhere, so a projection keyed on that column charged the wrong account.
    @Inject(forwardRef(() => ScheduledEffectiveAmountService))
    private readonly effectiveAmounts: ScheduledEffectiveAmountService,
  ) {}

  async getBalanceForecast(
    userId: string,
    accountId: string,
    days = 90,
  ): Promise<BalanceForecastResult> {
    const account = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).findOne({
        where: { id: accountId, userId },
      }),
    );
    if (!account) {
      throw new NotFoundException(
        tr(
          "errors.accounts.accountWithIdNotFound",
          `Account with ID ${accountId} not found`,
          {
            id: accountId,
          },
        ),
      );
    }

    const today = todayYMD();
    const horizon = addDaysYMD(today, days);

    // Balance as of end of today (excludes future-dated transactions), matching
    // the last point of the historical daily-balances series.
    const startRows: { balance: string }[] = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT COALESCE(a.opening_balance, 0)
         + COALESCE(SUM(CASE WHEN t.transaction_date <= $3 THEN t.amount ELSE 0 END), 0) AS balance
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id
         AND t.user_id = $2
         AND (t.status IS NULL OR t.status != 'VOID')
         AND t.parent_transaction_id IS NULL
       WHERE a.id = $1 AND a.user_id = $2
       GROUP BY a.id, a.opening_balance`,
          [accountId, userId, today],
        ),
    );
    const startBalance = roundMoney(
      Number(startRows?.[0]?.balance ?? account.openingBalance),
    );

    // Future-dated real transactions per day.
    const actualRows: { date: string; total: string }[] = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT t.transaction_date::TEXT AS date, SUM(t.amount)::NUMERIC AS total
       FROM transactions t
       WHERE t.account_id = $1
         AND t.user_id = $2
         AND (t.status IS NULL OR t.status != 'VOID')
         AND t.parent_transaction_id IS NULL
         AND t.transaction_date > $3
         AND t.transaction_date <= $4
       GROUP BY t.transaction_date`,
          [accountId, userId, today, horizon],
        ),
    );
    const actualByDate = new Map<string, number>();
    for (const r of actualRows) actualByDate.set(r.date, Number(r.total));

    // Candidate schedules. The first two arms are the ones that name this
    // account directly; the third brings in every active investment schedule
    // regardless of account, because an investment's `accountId` is the
    // brokerage and its cash may settle *here* -- which the column cannot say.
    // Narrow on purpose: loading every schedule per chart would be a much wider
    // read for the same answer.
    const candidates = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(ScheduledTransaction).find({
        where: [
          { userId, isActive: true, accountId },
          { userId, isActive: true, transferAccountId: accountId },
          { userId, isActive: true, isInvestment: true },
        ],
        // The splits decide whether a schedule's cash total re-prices at the
        // current rate, which the effective-amount resolver cannot answer
        // without them.
        relations: ["splits"],
      }),
    );

    // Per-occurrence overrides move a date and replace an amount, and the
    // cash-flow forecast already honours them -- an account chart that ignored
    // them disagreed with the forecast for every overridden occurrence.
    const candidateIds = candidates.map((c) => c.id);
    const overrides = candidateIds.length
      ? await withScopedDb(this.dataSource, (m) =>
          m.getRepository(ScheduledTransactionOverride).find({
            where: { scheduledTransactionId: In(candidateIds) },
          }),
        )
      : [];
    const overridesBySchedule = new Map<
      string,
      ScheduledTransactionOverride[]
    >();
    for (const o of overrides) {
      const list = overridesBySchedule.get(o.scheduledTransactionId) ?? [];
      list.push(o);
      overridesBySchedule.set(o.scheduledTransactionId, list);
    }
    const hydrated = candidates.map((c) => ({
      ...c,
      futureOverrides: overridesBySchedule.get(c.id) ?? [],
    }));

    // Resolved outside every read transaction: the rate path can fetch and
    // persist.
    const effective = await this.effectiveAmounts.resolveMany(userId, hydrated);

    const inputs: ForecastScheduleInput[] = [];
    for (const row of hydrated) {
      const resolved = effective.get(row.id)!;
      // Charge the occurrence to the account that actually moves the cash.
      const settlementAccountId = resolved.settlementAccountId;
      const isTransferTarget = row.transferAccountId === accountId;
      if (settlementAccountId !== accountId && !isTransferTarget) continue;

      const gap = this.gapFor(row, resolved, account, isTransferTarget);
      const overrideInputs: ForecastOverrideInput[] = (
        row.futureOverrides ?? []
      ).map((o) => {
        // `?.amount ?? base` would be wrong here: an override the resolver
        // priced as UNKNOWN reads as null, which `??` cannot tell from "no
        // entry" -- and falling through to the base amount is exactly the
        // substitution issue #1247 forbids. Branch on the entry, not the value.
        const own = resolved.overrides.get(overrideEffectiveKey(o));
        return {
          originalDate: ensureYMD(o.originalDate as unknown as string),
          overrideDate: ensureYMD(o.overrideDate as unknown as string),
          amount: gap
            ? null
            : own
              ? own.effective.amount
              : resolved.base.amount,
        };
      });

      inputs.push({
        id: row.id,
        name: row.name,
        accountId: settlementAccountId,
        transferAccountId: row.transferAccountId,
        amount: gap ? null : resolved.base.amount,
        gapReason: gap?.reason,
        gapFromCurrency: gap?.from ?? null,
        gapToCurrency: gap?.to ?? null,
        frequency: row.frequency,
        nextDueDate: ensureYMD(row.nextDueDate),
        endDate: row.endDate ? ensureYMD(row.endDate) : null,
        occurrencesRemaining: row.occurrencesRemaining,
        overrides: overrideInputs,
      });
    }

    const { byDate, gaps } = accumulateForecastDeltas(
      inputs,
      accountId,
      today,
      horizon,
      actualByDate,
    );
    const complete = gaps.length === 0;
    const points = complete
      ? buildForecastSeries(startBalance, today, horizon, byDate)
      : // Today's balance is a known fact and stays; everything after it is not.
        [{ date: today, balance: startBalance }];

    return {
      accountId,
      currencyCode: account.currencyCode,
      points,
      complete,
      gaps,
    };
  }

  /**
   * Whether this schedule can be projected onto `account` at all, and why not.
   *
   * Two ways it cannot, and neither may be papered over with the persisted
   * amount or an unconverted one (issue #1247):
   *
   *  - the resolver could not price the occurrence (an investment-carrying
   *    schedule whose current settlement rate is unknown);
   *  - the schedule is a transfer *into* this account from an account in another
   *    currency. Its `amount` is the source's, the arriving amount is resolved
   *    when it posts, and this endpoint applies no rate -- so adding the source
   *    figure would put a foreign number on this balance. That is a different
   *    defect from the stale snapshot and is reported under its own reason.
   *
   * The currency check on the priced case is deliberately a comparison rather
   * than an assumption: `base.currencyCode` is the settlement account's currency
   * by construction, so it should always equal this account's -- and if that ever
   * stops being true, the honest answer is a gap, not a silent addition.
   */
  private gapFor(
    row: ScheduledTransaction,
    resolved: {
      base: { amount: number | null; currencyCode: string };
      settlementPair: { from: string; to: string } | null;
    },
    account: Account,
    isTransferTarget: boolean,
  ): {
    reason: BalanceForecastGap["reason"];
    from: string | null;
    to: string | null;
  } | null {
    if (isTransferTarget && row.currencyCode !== account.currencyCode) {
      return {
        reason: "crossCurrencyTransfer",
        from: row.currencyCode,
        to: account.currencyCode,
      };
    }
    if (resolved.base.amount === null) {
      // Name the pair when there is one: "no rate from USD to CAD" is something
      // the reader can go and fix. A split parent's lines each settle their own
      // security's currency, so there is no single pair and the message says the
      // rate is unavailable without naming one.
      return {
        reason: "unresolvedSettlementRate",
        from: resolved.settlementPair?.from ?? null,
        to: resolved.settlementPair?.to ?? resolved.base.currencyCode,
      };
    }
    if (
      !isTransferTarget &&
      resolved.base.currencyCode !== account.currencyCode
    ) {
      return {
        reason: "unresolvedSettlementRate",
        from: resolved.base.currencyCode,
        to: account.currencyCode,
      };
    }
    return null;
  }
}
