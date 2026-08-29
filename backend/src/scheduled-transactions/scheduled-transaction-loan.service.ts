import { Injectable, Logger } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { PaymentFrequency } from "../accounts/loan-amortization.util";
import { getPeriodicRate } from "../accounts/mortgage-amortization.util";
import { roundMoney } from "../common/round.util";
import {
  allocateLoanPayment,
  LoanPaymentAllocation,
} from "../accounts/loan-payment-waterfall.util";
import { withScopedDb } from "../common/db/scoped-db";
import { ensureYMD } from "../common/recurrence";
import {
  DEFAULT_PERIODS_PER_YEAR,
  periodsPerYearForStoredFrequency,
} from "../accounts/payment-frequency.util";

// The account types that carry a scheduled loan-payment structure and therefore
// need their next principal/interest split advanced after each posting. This set
// must stay in step with what `LoanPaymentSetupService` accepts when it creates
// that structure -- it accepts LOAN, MORTGAGE and LINE_OF_CREDIT, so a LOC left
// out of the recalculation would keep billing the first installment's split
// forever (issue #1154 re-review).
const LOAN_LIKE_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set([
  AccountType.LOAN,
  AccountType.MORTGAGE,
  AccountType.LINE_OF_CREDIT,
]);

/** The template's managed lines: a principal transfer, one interest line, and
 *  optionally an extra-principal transfer. */
interface LoanTemplateSplits {
  principalSplit?: ScheduledTransactionSplit;
  interestSplit: ScheduledTransactionSplit;
  extraPrincipalSplit?: ScheduledTransactionSplit;
}

/** One resolved installment: what the next posting of this template should move. */
type ResolvedInstallment =
  | { kind: "declined"; reason: string }
  | { kind: "paid-off"; debt: number }
  | {
      kind: "ok";
      allocation: LoanPaymentAllocation;
      template: LoanTemplateSplits;
      debt: number;
      /** Configured installment total, extra principal included. */
      paymentAmount: number;
      basePaymentAmount: number;
      extraPrincipalAmount: number;
      templateAmount: number;
      templateExtraAmount: number;
    };

/** The effective split amounts a posting should write, keyed by scheduled-split id. */
export interface LoanPostingAllocation {
  /** Signed amounts (negative = payment out of the source account). */
  amountsBySplitId: Map<string, number>;
  /** Signed parent amount matching the sum of the managed children. */
  parentAmount: number;
}

@Injectable()
export class ScheduledTransactionLoanService {
  private readonly logger = new Logger(ScheduledTransactionLoanService.name);

  constructor(private dataSource: DataSource) {}

  async recalculateLoanPaymentSplits(
    scheduledTransactionId: string,
  ): Promise<void> {
    return withScopedDb(this.dataSource, async (m) => {
      // This writer mutates the child split set, so it must serialize through
      // the same parent lock the posting path takes (issue #1154 re-review): a
      // recalculation that changed principal/interest without the lock could
      // land between a poster's split-set guard and its write, and because a
      // P/I reallocation leaves the parent total unchanged, the poster's own
      // parent lock would not have blocked it. Lock the parent, then read the
      // current child set and derive the loan from it -- never from a loan id
      // captured off a pre-lock snapshot.
      const scheduledTransaction = await m
        .getRepository(ScheduledTransaction)
        .findOne({
          where: { id: scheduledTransactionId },
          lock: { mode: "pessimistic_write" },
        });

      if (!scheduledTransaction || !scheduledTransaction.isActive) {
        return;
      }

      const splits = await m.getRepository(ScheduledTransactionSplit).find({
        where: { scheduledTransactionId },
      });

      const loanAccount = await this.findLoanAccount(m, splits);
      if (!loanAccount) {
        return;
      }

      // Recalculation runs after the schedule advances, so the installment being
      // prepared is the one due at the (new) nextDueDate.
      const installment = await this.resolveInstallment(
        m,
        scheduledTransaction,
        splits,
        loanAccount,
        ensureYMD(scheduledTransaction.nextDueDate),
      );

      if (installment.kind === "paid-off") {
        await m
          .getRepository(ScheduledTransaction)
          .update(scheduledTransactionId, { isActive: false });
        return;
      }

      if (installment.kind === "declined") {
        this.logger.warn(
          `Skipping loan recalculation for scheduled transaction ${scheduledTransactionId}: ` +
            `${installment.reason}. ` +
            `Rewriting the parent would leave it unequal to the sum of its children and the occurrence would stop posting. ` +
            `Set the loan's interest category, or keep the template to principal + interest (+ extra principal).`,
        );
        return;
      }

      const {
        allocation,
        template,
        debt,
        paymentAmount,
        basePaymentAmount,
        extraPrincipalAmount,
        templateAmount,
        templateExtraAmount,
      } = installment;
      const { principalSplit, interestSplit, extraPrincipalSplit } = template;

      const newInterest = allocation.interest;
      const newPrincipal = allocation.principal;
      const finalExtraPrincipal = allocation.extraPrincipal;
      const requiredParentAmount = allocation.total;

      this.logger.log(
        `Recalculate loan splits: balance=${debt}, rate=${Number(loanAccount.interestRate) || 0}%, ` +
          `freq=${loanAccount.paymentFrequency || scheduledTransaction.frequency}, basePayment=${basePaymentAmount}, ` +
          `extra=${extraPrincipalAmount} (final ${finalExtraPrincipal}), ` +
          `newPrincipal=${newPrincipal}, newInterest=${newInterest}, ` +
          `isMortgage=${loanAccount.accountType === "MORTGAGE"}, ` +
          `isCanadian=${loanAccount.isCanadianMortgage}`,
      );

      if (principalSplit) {
        principalSplit.amount = -newPrincipal;
        await m.getRepository(ScheduledTransactionSplit).save(principalSplit);
      }

      if (interestSplit) {
        interestSplit.amount = -newInterest;
        await m.getRepository(ScheduledTransactionSplit).save(interestSplit);
      }

      // The extra principal child was never written here, so a clamped total had
      // nowhere to land: the parent would shrink while the children still summed
      // to the unclamped figure, and the posting path's split validator requires
      // exact 4dp equality between them (audit P5-008 again, on the child the
      // first fix did not reach). Written whenever it differs from what the
      // template holds -- in either direction, so one clamped installment does
      // not become the standing instruction (review #1131).
      if (extraPrincipalSplit && finalExtraPrincipal !== templateExtraAmount) {
        extraPrincipalSplit.amount = -finalExtraPrincipal;
        await m
          .getRepository(ScheduledTransactionSplit)
          .save(extraPrincipalSplit);
      }

      // Parent and children are written in the same transaction, so a posting
      // can never see one without the other. The parent is written whenever the
      // next installment differs from what the template holds: shrunk when the
      // debt no longer needs the whole configured payment, and grown back
      // toward the configured payment when a clamp written for one installment
      // no longer binds -- a voided final payment or an imported balance must
      // not leave the schedule billing the clamped figure forever (review
      // #1131). `allocateLoanPayment` bounds the total by the configured
      // payment, so this can never grow past what the user set.
      if (
        requiredParentAmount > 0 &&
        requiredParentAmount !== roundMoney(templateAmount)
      ) {
        await m
          .getRepository(ScheduledTransaction)
          .update(scheduledTransactionId, { amount: -requiredParentAmount });
        this.logger.log(
          `Loan payment recalculated: scheduled amount changed from ${templateAmount} to ${requiredParentAmount} (configured payment ${paymentAmount}, outstanding balance ${debt})`,
        );
      }
    });
  }

  /**
   * The effective principal/interest allocation for the occurrence about to be
   * posted, derived from the ledger at the consumption boundary.
   *
   * The stored split is a template computed when the *previous* occurrence
   * posted; any principal movement committed since (a standalone overpayment, a
   * void, an import) leaves it stale, and no mutation path recalculates it. So
   * the posting path calls this immediately before writing the financial
   * transaction -- inside the same scoped transaction and under the same parent
   * lock -- and posts these amounts instead of the persisted ones. When nothing
   * moved in between, this resolves to exactly what the template already holds.
   *
   * Returns null when the split set is not a managed loan template, when the
   * template shape is one the recalculation would also decline, or when the
   * debt through `asOfDate` is already retired -- in each case the posting
   * proceeds on the persisted amounts, which is today's behavior.
   */
  async resolvePostingAllocation(
    scheduledTransaction: ScheduledTransaction,
    splits: ScheduledTransactionSplit[],
    asOfDate: string,
  ): Promise<LoanPostingAllocation | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const loanAccount = await this.findLoanAccount(m, splits);
      if (!loanAccount) {
        return null;
      }

      const installment = await this.resolveInstallment(
        m,
        scheduledTransaction,
        splits,
        loanAccount,
        asOfDate,
      );
      if (installment.kind !== "ok") {
        return null;
      }

      const { allocation, template } = installment;
      const amountsBySplitId = new Map<string, number>();
      if (template.principalSplit?.id) {
        amountsBySplitId.set(template.principalSplit.id, -allocation.principal);
      }
      if (template.interestSplit.id) {
        amountsBySplitId.set(template.interestSplit.id, -allocation.interest);
      }
      if (template.extraPrincipalSplit?.id) {
        amountsBySplitId.set(
          template.extraPrincipalSplit.id,
          -allocation.extraPrincipal,
        );
      }
      return { amountsBySplitId, parentAmount: -allocation.total };
    });
  }

  /**
   * The authoritative anchor for projecting this loan's amortization forward:
   * the next scheduled installment's due date, and the debt measured from the
   * ledger through that date -- the same boundary the scheduled bill's own
   * interest is calculated from, so the first projected row and the next bill
   * cannot disagree about which balance they price (issue #1253).
   *
   * `nextDueDate`/`debt` are null when the loan has no active scheduled payment
   * transferring to it; a projection then has no bill to be in parity with and
   * anchors at today, which the caller keeps as its fallback.
   */
  async getLoanProjectionAnchor(
    userId: string,
    loanAccountId: string,
  ): Promise<{ nextDueDate: string | null; debt: number | null }> {
    return withScopedDb(this.dataSource, async (m) => {
      const loanAccount = await m.getRepository(Account).findOne({
        where: { id: loanAccountId, userId },
      });
      if (
        !loanAccount ||
        !LOAN_LIKE_ACCOUNT_TYPES.has(loanAccount.accountType)
      ) {
        return { nextDueDate: null, debt: null };
      }

      // The loan's scheduled payment is the active schedule holding a split
      // transferring to it -- the same linkage recalculation resolves in the
      // other direction. Two schedules against one loan is not a supported
      // shape; the earliest due one is the next bill.
      const scheduleRows: Array<{ next_due_date: string }> = await m.query(
        `SELECT TO_CHAR(st.next_due_date, 'YYYY-MM-DD') AS next_due_date
           FROM scheduled_transactions st
           JOIN scheduled_transaction_splits sts
             ON sts.scheduled_transaction_id = st.id
          WHERE st.user_id = $1
            AND st.is_active = true
            AND sts.transfer_account_id = $2
          ORDER BY st.next_due_date ASC
          LIMIT 1`,
        [userId, loanAccountId],
      );
      const nextDueDate = scheduleRows[0]?.next_due_date ?? null;
      if (!nextDueDate) {
        return { nextDueDate: null, debt: null };
      }

      const debt = await this.datedLoanDebt(m, loanAccount, nextDueDate);
      if (debt === null) {
        return { nextDueDate: null, debt: null };
      }
      return { nextDueDate, debt };
    });
  }

  /** The loan-like account a split set transfers to, if any. */
  private async findLoanAccount(
    m: EntityManager,
    splits: ScheduledTransactionSplit[],
  ): Promise<Account | null> {
    for (const split of splits) {
      if (!split.transferAccountId) continue;
      const candidate = await m.getRepository(Account).findOne({
        where: { id: split.transferAccountId },
      });
      if (candidate && LOAN_LIKE_ACCOUNT_TYPES.has(candidate.accountType)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * The outstanding debt through `asOfDate`, from the authoritative ledger:
   * opening balance plus every non-void, top-level transaction dated on or
   * before that date -- the same expression `recalculateCurrentBalance` and the
   * balances-as-of report use, with the installment boundary in place of today.
   *
   * `accounts.current_balance` deliberately excludes future-dated rows, so it
   * cannot price an installment after a future payment has been posted; and a
   * previously stored principal/interest split is money already rounded to 4dp,
   * so advancing it with an amortization recurrence compounds the rounding
   * (issue #1253). The dated ledger balance is the one source both the next
   * bill and the amortization projection can agree on.
   *
   * Null only when the account row cannot be read back (deleted concurrently);
   * a failed lookup is not a zero balance.
   */
  private async datedLoanDebt(
    m: EntityManager,
    loanAccount: Account,
    asOfDate: string,
  ): Promise<number | null> {
    const rows: Array<{ balance: string }> = await m.query(
      `SELECT COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) AS balance
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
          AND (t.status IS NULL OR t.status != 'VOID')
          AND t.parent_transaction_id IS NULL
          AND t.transaction_date <= $3
        WHERE a.id = $1 AND a.user_id = $2
        GROUP BY a.id, a.opening_balance`,
      [loanAccount.id, loanAccount.userId, asOfDate],
    );
    if (rows.length === 0 || rows[0].balance == null) {
      return null;
    }
    // Debt accounts store the balance negative; an overpaid balance (in
    // credit) reads as retired rather than as fresh debt.
    return Math.max(0, -roundMoney(Number(rows[0].balance)));
  }

  /**
   * The periodic rate the installment accrues at. One lookup for both
   * frequency spellings: the column is a bare VARCHAR written by two paths, so
   * a MORTGAGE row can hold the recurrence spelling SEMIMONTHLY -- cast into
   * getMortgagePeriodsPerYear it fell through to that function's monthly
   * default, and every posted split booked twice the interest for the life of
   * the loan. Account type still decides the COMPOUNDING (Canadian
   * semi-annual); it never decided the count.
   */
  private periodicRateFor(
    loanAccount: Account,
    frequency: PaymentFrequency,
    interestRate: number,
  ): number {
    const periodsPerYear =
      periodsPerYearForStoredFrequency(frequency) ?? DEFAULT_PERIODS_PER_YEAR;

    return loanAccount.accountType === "MORTGAGE"
      ? getPeriodicRate(
          interestRate,
          periodsPerYear,
          loanAccount.isCanadianMortgage,
          loanAccount.isVariableRate,
        )
      : interestRate / 100 / periodsPerYear;
  }

  /**
   * Resolve one installment of a scheduled loan payment: identify the managed
   * template lines, measure the debt through `asOfDate` from the ledger, price
   * the interest at the periodic rate, and run the shared waterfall.
   *
   * Interest comes from the dated ledger balance, never from the previously
   * stored split values: those are money already rounded to 4dp, and the
   * amortization recurrence (`next = prev_interest - prev_principal * rate`)
   * is equivalent to recalculating from balance only when its inputs retain
   * full precision -- so the recurrence drifted from the amortization report by
   * a compounding cent (issue #1253). Both the post-posting recalculation and
   * the posting-boundary resolution price through here, so the template and
   * what actually posts cannot use two different rules.
   */
  private async resolveInstallment(
    m: EntityManager,
    scheduledTransaction: ScheduledTransaction,
    splits: ScheduledTransactionSplit[],
    loanAccount: Account,
    asOfDate: string,
  ): Promise<ResolvedInstallment> {
    const loanAccountId = loanAccount.id;

    const debt = await this.datedLoanDebt(m, loanAccount, asOfDate);
    if (debt === null) {
      return {
        kind: "declined",
        reason: `the ledger balance for loan account ${loanAccountId} could not be read`,
      };
    }

    if (debt <= 0.01) {
      return { kind: "paid-off", debt };
    }

    const templateAmount = Math.abs(Number(scheduledTransaction.amount));
    const interestRate = Number(loanAccount.interestRate) || 0;
    const frequency = (loanAccount.paymentFrequency ||
      scheduledTransaction.frequency) as PaymentFrequency;

    // Identify splits: there may be a regular principal transfer, an interest
    // category split, and optionally a separate extra principal transfer.
    // Extra principal splits have memo "Extra Principal" and transfer to the
    // loan account. Regular principal also transfers to the loan account.
    const extraPrincipalSplit = splits.find(
      (s) =>
        s.transferAccountId === loanAccountId &&
        s.memo?.toLowerCase().includes("extra"),
    );
    const principalSplit = splits.find(
      (s) => s.transferAccountId === loanAccountId && s !== extraPrincipalSplit,
    );
    // Prefer the loan's configured interest category. "The first categorized
    // line" is an absence predicate -- it says the line is not the principal
    // transfer, not that it is interest -- so on a template a user has added
    // an escrow or insurance line to it recalculates whichever line happens to
    // be listed first. The configured category is the explicit statement, and
    // it is order-independent.
    const categoryLines = splits.filter(
      (s) => s.categoryId && !s.transferAccountId,
    );
    const interestSplit = loanAccount.interestCategoryId
      ? categoryLines.find(
          (s) => s.categoryId === loanAccount.interestCategoryId,
        )
      : categoryLines.length === 1
        ? categoryLines[0]
        : undefined;

    // This method understands exactly one template shape: a principal
    // transfer, one interest line, and optionally an extra-principal transfer.
    // It reprices the parent as principal + interest + extra, which is the
    // whole template only for that shape -- so a template carrying an escrow,
    // insurance or tax line ends up with a parent that no longer equals the
    // sum of its children, and the posting path's exact-4dp split validator
    // then refuses every occurrence. The schedule stops posting silently, with
    // the amount it would have charged nowhere on screen.
    //
    // So it declines rather than rewriting what it cannot account for. The
    // cost is a P/I split that stays at last period's figures; the alternative
    // cost is a bill that never posts again. Declining also removes the last
    // place a line was chosen by position: with several categorized lines and
    // no configured category, there is nothing here that identifies interest,
    // and guessing is what put an amortization figure onto a property-tax line.
    const unmanagedLines = splits.filter(
      (s) =>
        s !== interestSplit &&
        s !== principalSplit &&
        s !== extraPrincipalSplit,
    );
    if (!interestSplit || unmanagedLines.length > 0) {
      return {
        kind: "declined",
        reason: interestSplit
          ? `${unmanagedLines.length} line(s) beyond principal/interest/extra`
          : loanAccount.interestCategoryId
            ? "no line carries the loan's configured interest category"
            : `${categoryLines.length} categorized lines and no interest category configured on account ${loanAccountId}`,
      };
    }

    // What the template holds is what was just posted -- including any clamp
    // a previous pass wrote for that one installment (a final payment, an
    // interest spike consuming the extra). Deriving the *configured* payment
    // from it therefore ratchets: the clamp becomes the configuration and
    // nothing can grow back, even after the balance is restored by a void or
    // an import (review #1131). The durable configuration lives on the
    // account (payment_amount / extra_payment_amount, kept in sync when the
    // user edits the schedule); the template only wins where it is larger,
    // which can only mean a user edit the account columns have not seen.
    const templateExtraAmount = extraPrincipalSplit
      ? Math.abs(Number(extraPrincipalSplit.amount))
      : 0;
    const paymentAmount = Math.max(
      templateAmount,
      Number(loanAccount.paymentAmount) || 0,
    );
    // The extra can only ride in an existing split row -- this recalculation
    // never creates one -- so without the row the configured extra is 0.
    const extraPrincipalAmount = extraPrincipalSplit
      ? Math.max(
          templateExtraAmount,
          Number(loanAccount.extraPaymentAmount) || 0,
        )
      : 0;
    const basePaymentAmount = paymentAmount - extraPrincipalAmount;

    const periodicRate = this.periodicRateFor(
      loanAccount,
      frequency,
      interestRate,
    );

    const newInterest = roundMoney(debt * periodicRate);
    let newPrincipal = roundMoney(basePaymentAmount - newInterest);
    if (newPrincipal < 0) newPrincipal = 0;

    // The clamp sequence -- interest-first across the whole installment
    // (recheck RR2-006, DR3-01), principal bounded by the debt with the
    // discretionary extra absorbing the shortfall (audit P5-008, FR-009) --
    // is `allocateLoanPayment`, shared with the first installment written by
    // `LoanPaymentSetupService` because the two must agree about what any
    // installment looks like.
    const allocation = allocateLoanPayment({
      paymentAmount,
      extraPrincipal: extraPrincipalAmount,
      interest: newInterest,
      principal: newPrincipal,
      currentBalance: debt,
    });

    return {
      kind: "ok",
      allocation,
      template: { principalSplit, interestSplit, extraPrincipalSplit },
      debt,
      paymentAmount,
      basePaymentAmount,
      extraPrincipalAmount,
      templateAmount,
      templateExtraAmount,
    };
  }

  async findLoanAccountFromSplits(
    splits: ScheduledTransactionSplit[],
  ): Promise<string | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const account = await this.findLoanAccount(m, splits);
      return account ? account.id : null;
    });
  }
}
