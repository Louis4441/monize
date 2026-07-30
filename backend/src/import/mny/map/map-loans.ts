import { AccountType } from "../../../accounts/entities/account.entity";
import { InterestBookingMode } from "../../../accounts/entities/account.entity";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { roundMoney } from "../../../common/round.util";
import {
  MappedAccounts,
  MappedBill,
  MappedLoanTerms,
  MappedLoans,
  MappedTransactions,
} from "../model/mny-import-model";

/**
 * Loan and mortgage terms inferred from the payments Money recorded.
 *
 * Money has no loan-terms table Monize can read directly, but a loan payment's
 * *shape* says most of what the loan schedule and the interest-rate detection
 * need: a payment that transfers principal into the loan account and books
 * interest as a sibling category leg is exactly Monize's `SPLIT` interest
 * booking mode, and the account the payment comes from is the loan's funding
 * account.
 *
 * Getting this right matters beyond tidiness. `RateChangeInferenceService`
 * reads `interestBookingMode`: left at `AUTO` on a split-booked loan it also
 * pairs standalone interest expenses, which double-counts interest for a loan
 * whose interest is only ever a split leg.
 *
 * Nothing is guessed. A category is adopted as the loan's interest category
 * only when the payments name exactly one non-principal category -- a loan with
 * an escrow leg names two or more, so it keeps a null interest category rather
 * than having escrow silently labelled as interest.
 */

/** Loan-shaped account types, the only ones these terms apply to. */
const LOAN_TYPES: ReadonlySet<AccountType> = new Set([
  AccountType.LOAN,
  AccountType.MORTGAGE,
]);

export interface MapLoansInput {
  readonly accounts: MappedAccounts;
  readonly transactions: MappedTransactions;
  /** Selected bills, so a loan's scheduled payment can supply its terms. */
  readonly bills: readonly MappedBill[];
}

/** One loan account's evidence, accumulated across its payments. */
interface Evidence {
  /** Category handles of the non-principal legs of its payments. */
  readonly interestCategories: Map<number, number>;
  /** Account keys the payments were made from, by frequency. */
  readonly sourceKeys: Map<string, number>;
  /** Payment totals, so the most common installment can be recovered. */
  readonly paymentAmounts: Map<number, number>;
  /** Payments that reached the loan through a transfer split. */
  splitPayments: number;
  /** Payments that reached the loan as a plain, unsplit transfer. */
  plainTransfers: number;
}

function newEvidence(): Evidence {
  return {
    interestCategories: new Map(),
    sourceKeys: new Map(),
    paymentAmounts: new Map(),
    splitPayments: 0,
    plainTransfers: 0,
  };
}

function bump<K>(counter: Map<K, number>, key: K): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

/** The value seen most often, or null on a tie or an empty counter. */
function mostCommon<K>(counter: ReadonlyMap<K, number>): K | null {
  let best: K | null = null;
  let bestCount = 0;
  let tied = false;

  for (const [key, count] of counter) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }

  return tied ? null : best;
}

/**
 * Reads every imported transaction for evidence about the loan accounts its
 * transfers point at.
 */
function collectEvidence(
  input: MapLoansInput,
  loanKeys: ReadonlySet<string>,
): Map<string, Evidence> {
  const evidenceByKey = new Map<string, Evidence>();
  const evidenceFor = (key: string): Evidence => {
    const existing = evidenceByKey.get(key);
    if (existing) {
      return existing;
    }
    const fresh = newEvidence();
    evidenceByKey.set(key, fresh);
    return fresh;
  };

  // A plain transfer names its counterpart by id, not by account, so the
  // counterpart's account is resolved through this.
  const accountKeyById = new Map(
    input.transactions.transactions.map((transaction) => [
      transaction.id,
      transaction.accountKey,
    ]),
  );

  for (const transaction of input.transactions.transactions) {
    // The payment itself is never in the loan account: it is in the account
    // the money left, and its transfer leg points at the loan.
    if (loanKeys.has(transaction.accountKey)) {
      continue;
    }

    // An unsplit transfer into the loan: principal only, with interest booked
    // somewhere else (or not at all).
    if (transaction.splits.length === 0 && transaction.linkedTransactionId) {
      const targetKey = accountKeyById.get(transaction.linkedTransactionId);
      if (targetKey !== undefined && loanKeys.has(targetKey)) {
        const evidence = evidenceFor(targetKey);
        evidence.plainTransfers += 1;
        bump(evidence.sourceKeys, transaction.accountKey);
        bump(evidence.paymentAmounts, roundMoney(Math.abs(transaction.amount)));
      }
      continue;
    }

    const transferLegs = transaction.splits.filter(
      (split) =>
        split.kind === SplitKind.TRANSFER &&
        split.transferAccountKey !== null &&
        loanKeys.has(split.transferAccountKey),
    );

    for (const leg of transferLegs) {
      const evidence = evidenceFor(leg.transferAccountKey as string);
      evidence.splitPayments += 1;
      bump(evidence.sourceKeys, transaction.accountKey);
      bump(evidence.paymentAmounts, roundMoney(Math.abs(transaction.amount)));

      // Sibling category legs are the interest and escrow portions.
      for (const sibling of transaction.splits) {
        if (
          sibling.kind === SplitKind.CATEGORY &&
          sibling.categoryHandle !== null
        ) {
          bump(evidence.interestCategories, sibling.categoryHandle);
        }
      }
    }
  }

  return evidenceByKey;
}

/**
 * A loan's payment terms from the bill that pays it, when one was imported.
 * The bill is better evidence than the payment history for the *scheduled*
 * amount and cadence: it is what Money itself was going to post next.
 */
function billTermsFor(
  loanKey: string,
  bills: readonly MappedBill[],
): MappedBill | null {
  return (
    bills.find(
      (bill) =>
        bill.transferAccountKey === loanKey ||
        bill.splits.some((split) => split.transferAccountKey === loanKey),
    ) ?? null
  );
}

/**
 * Derives per-loan terms from the imported payments and bills.
 *
 * Returns an entry only for loans where the evidence says something: a loan
 * with no imported payments and no bill is left entirely alone rather than
 * being written with defaults.
 */
export function mapLoans(input: MapLoansInput): MappedLoans {
  const loanAccounts = input.accounts.accounts.filter((account) =>
    LOAN_TYPES.has(account.accountType),
  );
  if (loanAccounts.length === 0) {
    return { loans: [], warnings: [] };
  }

  const loanKeys = new Set(loanAccounts.map((account) => account.key));
  const evidenceByKey = collectEvidence(input, loanKeys);
  const loans: MappedLoanTerms[] = [];

  for (const account of loanAccounts) {
    const evidence = evidenceByKey.get(account.key);
    const bill = billTermsFor(account.key, input.bills);
    if (!evidence && !bill) {
      continue;
    }

    // Exactly one non-principal category means interest with no escrow leg;
    // two or more means escrow is in the mix and neither can be told apart, so
    // the category stays unset rather than mislabelling escrow as interest.
    const categories =
      evidence?.interestCategories ?? new Map<number, number>();
    const interestCategoryHandle =
      categories.size === 1 ? [...categories.keys()][0] : null;

    const sourceAccountKey = evidence
      ? mostCommon(evidence.sourceKeys)
      : (bill?.accountKey ?? null);

    // SPLIT only when every observed payment was split-booked. A loan that also
    // receives plain transfers has its interest booked somewhere else, and
    // claiming SPLIT there would suppress the separate-interest pairing that
    // recovers those rate observations.
    const interestBookingMode: InterestBookingMode | null =
      evidence && evidence.splitPayments > 0 && evidence.plainTransfers === 0
        ? "SPLIT"
        : null;

    loans.push({
      accountKey: account.key,
      interestCategoryHandle,
      interestBookingMode,
      sourceAccountKey: sourceAccountKey ?? bill?.accountKey ?? null,
      paymentAmount: bill
        ? roundMoney(Math.abs(bill.amount))
        : evidence
          ? mostCommon(evidence.paymentAmounts)
          : null,
      paymentFrequency: bill?.frequency ?? null,
      paymentStartDate: bill?.nextDueDate ?? null,
      paymentsObserved: evidence?.splitPayments ?? 0,
    });
  }

  return {
    loans,
    warnings: loans
      .filter(
        (loan) =>
          loan.interestCategoryHandle === null && loan.paymentsObserved > 0,
      )
      .map((loan) => ({
        code: "loanInterestCategoryUnclear" as const,
        subject:
          input.accounts.accounts.find(
            (account) => account.key === loan.accountKey,
          )?.name ?? loan.accountKey,
      })),
  };
}
