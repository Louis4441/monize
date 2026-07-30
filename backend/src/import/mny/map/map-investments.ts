import { randomUUID } from "node:crypto";
import { AccountSubType } from "../../../accounts/entities/account.entity";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import { roundMoney, roundToDecimals } from "../../../common/round.util";
import {
  MappedAccounts,
  MappedInvestmentTransaction,
  MappedInvestments,
  MappedSecurities,
} from "../model/mny-import-model";
import {
  MNY_UNCONFIRMED_ACTIONS,
  hasInvestmentDetail,
  isRecurrenceTemplate,
  mapInvestmentAction,
  mapTransactionStatus,
} from "../model/mny-model";
import { MnyBill, MnyTransaction } from "../model/mny-rows";
import { MnyWarning } from "../model/mny-warnings";
import { MnyInvestmentData } from "../tables/read-investments";
import { MnyTransactionData } from "../tables/read-transactions";

/**
 * `TRN` rows carrying a security, mapped onto Monize investment transactions.
 *
 * Every rule here answers a specific way PR #192 corrupted positions (issue 4 in
 * the design's assessment table):
 *
 * - **Driven from `TRN`, not `TRN_INV`.** A cash dividend (`act` 4) has no
 *   `TRN_INV` row at all, so iterating the detail table dropped every one of
 *   them. Investment rows are identified by carrying a security, never by their
 *   action code -- `act = 0` is BUY and is indistinguishable from a plain
 *   payment by code alone.
 * - **`act` 16 is REMOVE_SHARES, never SELL.** It closes lots without a sale, so
 *   mapping it to SELL both invented proceeds and corrupted average cost.
 * - **Quantity is always positive.** `TRN_INV.qty` is stored positive and
 *   direction comes only from the action; inferring it from a sign is what
 *   produced negative positions.
 * - **`SEC_SPLIT` is applied.** Ignoring stock splits leaves every post-split
 *   position wrong by the split ratio.
 *
 * Nothing here touches the database, and no code is guessed: an action outside
 * the known set is skipped and counted, and an action whose meaning is inferred
 * rather than observed (`act` 5 and 14) carries a warning on every row it maps.
 */

/** Quantities are `decimal(20,8)`; ratios and share counts round to match. */
const QUANTITY_DECIMALS = 8;

/** Prices are `decimal(20,6)`. */
const PRICE_DECIMALS = 6;

/** Shares move and no money changes hands, so the transaction has no value. */
const ZERO_TOTAL_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.ADD_SHARES,
  InvestmentAction.REMOVE_SHARES,
  InvestmentAction.TRANSFER_IN,
  InvestmentAction.TRANSFER_OUT,
  InvestmentAction.SPLIT,
]);

/**
 * Actions that never touch the cash sleeve. A reinvested distribution has a
 * real value but the money buys shares without ever landing as cash, so it has
 * a total and no cash leg.
 */
const NO_CASH_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  ...ZERO_TOTAL_ACTIONS,
  InvestmentAction.REINVEST,
]);

/** Cash leaves the sleeve; every other cash-moving action pays into it. */
const CASH_OUT_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.BUY,
]);

export interface MapInvestmentsInput {
  readonly transactions: MnyTransactionData;
  readonly investments: MnyInvestmentData;
  readonly accounts: MappedAccounts;
  readonly securities: MappedSecurities;
  /** `BILL` rows, so their template transactions are not imported as postings. */
  readonly bills: readonly MnyBill[];
}

interface Context {
  readonly input: MapInvestmentsInput;
  /** `TRN_INV.htrn` -> the detail row, when the file has one. */
  readonly detailByHandle: ReadonlyMap<number, MnyInvestmentDetailValues>;
  /** Brokerage account key -> the cash sleeve that takes its cash legs. */
  readonly cashKeyByAccountKey: ReadonlyMap<string, string>;
  /** Account keys that are brokerage sides, so shares land somewhere real. */
  readonly brokerageKeys: ReadonlySet<string>;
  readonly warnings: MnyWarning[];
}

interface MnyInvestmentDetailValues {
  readonly price: number;
  readonly quantity: number;
  readonly commission: number;
}

/**
 * Ordering key within a date. A split applies to whatever the account holds at
 * the end of the day, so it must fold after that day's trades -- the holdings
 * rebuild orders by date and then by insertion, and rows inserted in one
 * statement share a `created_at`.
 */
function sortRank(transaction: MappedInvestmentTransaction): number {
  return transaction.action === InvestmentAction.SPLIT ? 1 : 0;
}

function orderForReplay(
  transactions: readonly MappedInvestmentTransaction[],
): MappedInvestmentTransaction[] {
  return [...transactions].sort((a, b) => {
    if (a.transactionDate !== b.transactionDate) {
      return a.transactionDate < b.transactionDate ? -1 : 1;
    }
    return sortRank(a) - sortRank(b);
  });
}

function indexDetails(
  investments: MnyInvestmentData,
): Map<number, MnyInvestmentDetailValues> {
  const byHandle = new Map<number, MnyInvestmentDetailValues>();
  for (const detail of investments.investmentDetails) {
    if (detail.transaction === null) {
      continue;
    }
    byHandle.set(detail.transaction, {
      price: detail.price,
      quantity: detail.quantity,
      commission: detail.commission,
    });
  }
  return byHandle;
}

/** `BILL.lHtrn` rows are recurrence templates, never postings. */
function billTemplateHandles(bills: readonly MnyBill[]): ReadonlySet<number> {
  return new Set(
    bills
      .map((bill) => bill.templateTransaction)
      .filter((handle): handle is number => handle !== null),
  );
}

/**
 * The magnitude of the transaction.
 *
 * `TRN.amt` is Money's own cash figure and wins where it has one: it already
 * carries commission and any accrued interest, so recomputing from quantity and
 * price would disagree with what Money shows by those amounts. The sign is
 * discarded and taken from the action instead, which is the same rule that
 * governs quantity.
 */
function totalAmountOf(
  row: MnyTransaction,
  action: InvestmentAction,
  quantity: number | null,
  price: number | null,
  commission: number,
): number {
  if (ZERO_TOTAL_ACTIONS.has(action)) {
    return 0;
  }
  if (row.amount !== 0) {
    return roundMoney(Math.abs(row.amount));
  }
  if (quantity === null || price === null) {
    return 0;
  }
  const gross = quantity * price;
  return roundMoney(
    action === InvestmentAction.SELL ? gross - commission : gross + commission,
  );
}

/** Signed impact on the cash sleeve. Direction comes from the action only. */
function cashAmountOf(action: InvestmentAction, totalAmount: number): number {
  if (NO_CASH_ACTIONS.has(action) || totalAmount === 0) {
    return 0;
  }
  return CASH_OUT_ACTIONS.has(action) ? -totalAmount : totalAmount;
}

function positiveOrNull(value: number, decimals: number): number | null {
  const rounded = roundToDecimals(Math.abs(value), decimals);
  return rounded > 0 ? rounded : null;
}

function mapOne(
  row: MnyTransaction,
  accountKey: string,
  action: InvestmentAction,
  context: Context,
): MappedInvestmentTransaction {
  const handle = row.handle as number;
  const detail = context.detailByHandle.get(handle);

  if (!detail && hasInvestmentDetail(row.action)) {
    // The cash figure on the TRN row is still real, so the row imports without
    // a share movement rather than being dropped or having one invented.
    context.warnings.push({
      code: "missingInvestmentDetail",
      subject: `htrn=${handle}`,
      detail: `act=${row.action}`,
    });
  }

  const quantity = detail
    ? positiveOrNull(detail.quantity, QUANTITY_DECIMALS)
    : null;
  const price = detail ? positiveOrNull(detail.price, PRICE_DECIMALS) : null;
  const commission = detail ? roundMoney(Math.abs(detail.commission)) : 0;
  const totalAmount = totalAmountOf(row, action, quantity, price, commission);
  const cashAmount = cashAmountOf(action, totalAmount);

  return {
    id: randomUUID(),
    handle,
    accountKey,
    cashAccountKey:
      cashAmount === 0
        ? null
        : (context.cashKeyByAccountKey.get(accountKey) ?? null),
    securityHandle: row.security as number,
    action,
    transactionDate: row.date as string,
    quantity,
    price,
    commission,
    totalAmount,
    currencyCode:
      context.input.accounts.currencyByHandle.get(row.account as number) ?? "",
    cashAmount,
    status: mapTransactionStatus(row.clearedStatus, row.flags),
    payeeHandle: row.payee,
    categoryHandle: row.category,
    description: row.memo,
    linkedInvestmentId: null,
  };
}

/**
 * Turns matching `act` 15 / `act` 16 rows into a linked TRANSFER_IN /
 * TRANSFER_OUT pair.
 *
 * Money records a security moving between accounts as two independent rows: an
 * ADD_SHARES in the destination and a REMOVE_SHARES in the source, with nothing
 * connecting them. They are the same event, so they are matched on date,
 * security and quantity across two different accounts.
 *
 * An unpaired row stays ADD/REMOVE_SHARES and produces **no warning**: that is
 * exactly what Money recorded and the position it produces is identical either
 * way. Opening a portfolio with shares transferred in from a broker is the
 * ordinary case, not an anomaly -- `money2002.mny` alone has 60 of them, which
 * is 60 lines of noise burying the warnings that do mean something.
 */
function pairShareTransfers(
  transactions: readonly MappedInvestmentTransaction[],
): { transactions: MappedInvestmentTransaction[]; paired: number } {
  const key = (transaction: MappedInvestmentTransaction): string =>
    `${transaction.transactionDate}|${transaction.securityHandle}|${transaction.quantity ?? 0}`;

  const removals = new Map<string, MappedInvestmentTransaction[]>();
  for (const transaction of transactions) {
    if (transaction.action !== InvestmentAction.REMOVE_SHARES) {
      continue;
    }
    const bucket = removals.get(key(transaction)) ?? [];
    removals.set(key(transaction), [...bucket, transaction]);
  }

  /** id -> the id it links to, and the action it becomes. */
  const rewrites = new Map<
    string,
    { action: InvestmentAction; linkedInvestmentId: string }
  >();
  const claimed = new Set<string>();
  let paired = 0;

  for (const addition of transactions) {
    if (
      addition.action !== InvestmentAction.ADD_SHARES ||
      addition.quantity === null
    ) {
      continue;
    }
    const partner = (removals.get(key(addition)) ?? []).find(
      (candidate) =>
        !claimed.has(candidate.id) &&
        candidate.accountKey !== addition.accountKey,
    );
    if (!partner) {
      continue;
    }

    claimed.add(partner.id);
    claimed.add(addition.id);
    rewrites.set(addition.id, {
      action: InvestmentAction.TRANSFER_IN,
      linkedInvestmentId: partner.id,
    });
    rewrites.set(partner.id, {
      action: InvestmentAction.TRANSFER_OUT,
      linkedInvestmentId: addition.id,
    });
    paired += 1;
  }

  const rewritten = transactions.map((transaction) => {
    const rewrite = rewrites.get(transaction.id);
    return rewrite
      ? {
          ...transaction,
          action: rewrite.action,
          linkedInvestmentId: rewrite.linkedInvestmentId,
        }
      : transaction;
  });

  return { transactions: rewritten, paired };
}

/**
 * Synthesizes a SPLIT row per account holding the security on the split date.
 *
 * `SEC_SPLIT` carries no security handle of its own -- the link runs through the
 * `SP` price rows that reference it -- and no account, because a split applies
 * to every holder. So the accounts come from which ones traded the security on
 * or before the record date, and the quantity is the ratio the holdings fold
 * multiplies the position by.
 */
function synthesizeSplits(
  transactions: readonly MappedInvestmentTransaction[],
  context: Context,
): MappedInvestmentTransaction[] {
  const { securitySplits, splitSecurities } = context.input.investments;
  if (securitySplits.length === 0) {
    return [];
  }

  const created: MappedInvestmentTransaction[] = [];

  for (const split of securitySplits) {
    if (split.handle === null) {
      continue;
    }
    const securityHandle = splitSecurities.get(split.handle) ?? null;
    const ratio =
      split.sharesBefore > 0 ? split.sharesAfter / split.sharesBefore : 0;

    if (
      securityHandle === null ||
      !context.input.securities.byHandle.has(securityHandle) ||
      split.recordDate === null ||
      !Number.isFinite(ratio) ||
      ratio <= 0
    ) {
      context.warnings.push({
        code: "unusableSecuritySplit",
        subject: `hss=${split.handle}`,
        detail:
          securityHandle === null
            ? "no security"
            : split.recordDate === null
              ? "no record date"
              : `ratio ${split.sharesAfter}/${split.sharesBefore}`,
      });
      continue;
    }

    const holders = new Set(
      transactions
        .filter(
          (transaction) =>
            transaction.securityHandle === securityHandle &&
            transaction.transactionDate <= (split.recordDate as string),
        )
        .map((transaction) => transaction.accountKey),
    );

    for (const accountKey of holders) {
      created.push({
        id: randomUUID(),
        handle: null,
        accountKey,
        cashAccountKey: null,
        securityHandle,
        action: InvestmentAction.SPLIT,
        transactionDate: split.recordDate,
        quantity: roundToDecimals(ratio, QUANTITY_DECIMALS),
        price: positiveOrNull(split.price, PRICE_DECIMALS),
        commission: 0,
        totalAmount: 0,
        currencyCode:
          context.input.securities.byHandle.get(securityHandle)?.currencyCode ??
          "",
        cashAmount: 0,
        status: TransactionStatus.CLEARED,
        payeeHandle: null,
        categoryHandle: null,
        description: null,
        linkedInvestmentId: null,
      });
    }
  }

  return created;
}

function buildContext(input: MapInvestmentsInput): Context {
  const cashKeyByAccountKey = new Map<string, string>();
  const brokerageKeys = new Set<string>();

  for (const account of input.accounts.accounts) {
    if (account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE) {
      brokerageKeys.add(account.key);
      if (account.linkedKey) {
        cashKeyByAccountKey.set(account.key, account.linkedKey);
      }
    }
  }

  return {
    input,
    detailByHandle: indexDetails(input.investments),
    cashKeyByAccountKey,
    brokerageKeys,
    warnings: [],
  };
}

export function mapInvestments(input: MapInvestmentsInput): MappedInvestments {
  const context = buildContext(input);
  const warnings = context.warnings;
  const templates = billTemplateHandles(input.bills);
  const splitChildren = new Set(
    input.transactions.splits
      .map((split) => split.child)
      .filter((child): child is number => child !== null),
  );

  const mapped: MappedInvestmentTransaction[] = [];
  let skipped = 0;

  for (const row of input.transactions.transactions) {
    if (
      row.handle === null ||
      row.security === null ||
      splitChildren.has(row.handle) ||
      templates.has(row.handle) ||
      isRecurrenceTemplate(row.frequency)
    ) {
      continue;
    }

    const accountKey =
      row.account === null
        ? null
        : (input.accounts.keyByHandle.get(row.account) ?? null);
    if (accountKey === null) {
      // The account was left out of the import: a choice, not a data problem.
      continue;
    }

    if (row.date === null) {
      skipped += 1;
      warnings.push({
        code: "unusableTransaction",
        subject: `htrn=${row.handle}`,
        detail: "no usable date",
      });
      continue;
    }

    if (!input.securities.byHandle.has(row.security)) {
      // A currency pseudo-security, or a SEC row with no usable identity.
      skipped += 1;
      warnings.push({
        code: "missingInvestmentDetail",
        subject: `htrn=${row.handle}`,
        detail: `hsec=${row.security}`,
      });
      continue;
    }

    if (!context.brokerageKeys.has(accountKey)) {
      skipped += 1;
      warnings.push({
        code: "investmentAccountMismatch",
        subject: `htrn=${row.handle}`,
        detail: accountKey,
      });
      continue;
    }

    const action = mapInvestmentAction(row.action);
    if (action === null) {
      skipped += 1;
      warnings.push({
        code: "unknownInvestmentAction",
        subject: `htrn=${row.handle}`,
        detail: `act=${row.action}`,
      });
      continue;
    }

    if (MNY_UNCONFIRMED_ACTIONS.has(row.action)) {
      warnings.push({
        code: "unconfirmedInvestmentAction",
        subject: `htrn=${row.handle}`,
        detail: `act=${row.action}`,
      });
    }

    mapped.push(mapOne(row, accountKey, action, context));
  }

  const paired = pairShareTransfers(mapped);
  const splits = synthesizeSplits(paired.transactions, context);
  const transactions = orderForReplay([...paired.transactions, ...splits]);

  return {
    transactions,
    referencedSecurities: new Set(
      transactions.map((transaction) => transaction.securityHandle),
    ),
    referencedPayees: new Set(
      transactions
        .map((transaction) => transaction.payeeHandle)
        .filter((handle): handle is number => handle !== null),
    ),
    referencedCategories: new Set(
      transactions
        .map((transaction) => transaction.categoryHandle)
        .filter((handle): handle is number => handle !== null),
    ),
    transfersPaired: paired.paired,
    splitsApplied: splits.length,
    skipped,
    warnings,
  };
}
