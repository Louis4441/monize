import { Injectable } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import type { PendingAiAction } from "../../ai/actions/ai-action.types";
import { AiReviewRequestsService } from "../../ai-review/ai-review-requests.service";
import { AiReviewWorkService } from "../../ai-review/ai-review-work.service";
import {
  EMAIL_RECEIPTS_CLAIM_KEY,
  type AiReviewTradeInput,
} from "../../ai-review/ai-review-work.types";
import { returnedRows } from "../../common/db/query-result";
import { roundMoney } from "../../common/round.util";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";
import { escapeLikePattern } from "../../transactions/transaction-search.util";
import type { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import type {
  EmailReceipt,
  EmailReceiptStatus,
} from "../entities/email-receipt.entity";
import { effectiveReceiptDate } from "../imap/forwarded-receipt";
import { parseTradeLines } from "../parsing/parse-trade";
import type {
  ParsedTrade,
  ReceiptTradeDefinition,
} from "../parsing/receipt-parser.types";
import { isRefusal, refusalNote } from "./receipt-failure";
import { RECEIPT_TRADE_INSTRUCTION } from "./receipt-instructions";
import { closeReceiptRequests } from "./receipt-requests.util";

/** The `status_reason` of an email whose trade is already in the ledger. */
export const RECEIPT_TRADE_EXISTS_REASON = "trade_exists";
const MONEY_UNITS = 10_000;
const MAX_DESCRIPTION = 200;

/** What reading one trade email decided: the receipt's new state and, when the gate passed, the card to confirm. */
export interface TradeOutcome {
  status: EmailReceiptStatus;
  reason: string | null;
  /** The `email_trade` request the receipt now stands behind; null when it holds none. */
  requestId: string | null;
  trade: ParsedTrade;
  /** Present when the opt-in auto-apply gate passed: the signed card to confirm. */
  autoApply: PendingAiAction | null;
}

export interface TradeContext {
  parser: EmailReceiptParser;
  definition: ReceiptTradeDefinition;
  lines: readonly string[];
  mailboxAutoApply: boolean;
}

/**
 * Reads a brokerage trade-confirmation email through to a proposal to CREATE the
 * investment transaction it reports (design "Trade confirmations"). It runs
 * inside the pipeline's transaction, under the receipt's row lock: read the
 * lines with the profile's `trade` section, refuse a trade the ledger already
 * holds, queue an `email_trade` request born claimed by this module, and store
 * the signed card as its proposal. Nothing here writes the ledger: the row is
 * created by `/ai/actions/confirm` after a person approves the card, or by the
 * same call after the opt-in auto-apply gate (INV-RECEIPT-003).
 */
@Injectable()
export class EmailReceiptTradeService {
  constructor(
    private readonly requests: AiReviewRequestsService,
    private readonly work: AiReviewWorkService,
  ) {}

  async process(
    m: EntityManager,
    userId: string,
    receipt: EmailReceipt,
    context: TradeContext,
  ): Promise<TradeOutcome> {
    const trade = parseTradeLines(context.definition, context.lines);
    const outcome = (
      status: EmailReceiptStatus,
      reason: string | null,
      requestId: string | null = null,
      autoApply: PendingAiAction | null = null,
    ): TradeOutcome => ({ status, reason, requestId, trade, autoApply });

    if (!trade.complete) return outcome("parse_failed", trade.reason);
    const input = this.toInput(receipt, trade);

    // The ledger may already hold this trade (a manual entry, a broker import).
    // Creating it twice is the worst thing automation can do here, so it is an
    // ignored email that says why, never a second proposal.
    if (await this.alreadyBooked(m, userId, input)) {
      return outcome("ignored", RECEIPT_TRADE_EXISTS_REASON);
    }

    // A reprocess replaces the proposal: the receipt's earlier requests close
    // first, so the one-open-request-per-email index never refuses this one.
    await closeReceiptRequests(m, userId, receipt.id);
    const request = await this.requests.enqueueTrade(m, userId, {
      emailReceiptId: receipt.id,
      instruction: RECEIPT_TRADE_INSTRUCTION,
      claimedBy: EMAIL_RECEIPTS_CLAIM_KEY,
    });
    if (!request) return outcome("review_conflict", null);

    try {
      const done = await this.work.submitTrade(
        userId,
        EMAIL_RECEIPTS_CLAIM_KEY,
        request.id,
        input,
      );
      const gate =
        context.mailboxAutoApply &&
        context.parser.status === "approved" &&
        trade.consistent === true;
      return outcome("review", null, request.id, gate ? done.action : null);
    } catch (error) {
      if (!isRefusal(error)) throw error;
      await this.requests.release(
        userId,
        request.id,
        EMAIL_RECEIPTS_CLAIM_KEY,
        {
          final: true,
          note: refusalNote(error),
        },
      );
      return outcome("review", "proposal_refused", request.id);
    }
  }

  /** The proposal a complete reading makes: the day, the executed total and the commission, in currency units. */
  private toInput(
    receipt: EmailReceipt,
    trade: ParsedTrade,
  ): AiReviewTradeInput {
    const quantity = trade.quantity as number;
    const commission = (trade.commission ?? 0) / MONEY_UNITS;
    const action = trade.action as "BUY" | "SELL";
    // The executed total is the fact. An email that states only a price gives
    // the total its price implies (commission added to a buy, taken from a sell).
    const total =
      trade.total !== null
        ? trade.total / MONEY_UNITS
        : roundMoney(
            quantity * ((trade.price as number) / MONEY_UNITS) +
              (action === "BUY" ? commission : -commission),
          );
    return {
      accountId: trade.accountId as string,
      action,
      symbol: trade.symbol as string,
      quantity,
      totalAmount: total,
      commission,
      date:
        trade.date ?? effectiveReceiptDate(receipt).toISOString().slice(0, 10),
      description: `Email receipt: ${receipt.subject}`.slice(
        0,
        MAX_DESCRIPTION,
      ),
    };
  }

  /** Whether an investment transaction with this account, direction, security, day and share count exists (a VOID one does not count). */
  private async alreadyBooked(
    m: EntityManager,
    userId: string,
    input: AiReviewTradeInput,
  ): Promise<boolean> {
    const rows = returnedRows<{ id: string }>(
      await m.query(
        `SELECT it.id
           FROM investment_transactions it
           JOIN securities s ON s.id = it.security_id
          WHERE it.user_id = $1
            AND it.account_id = $2
            AND it.action = $3
            AND it.transaction_date = $4::date
            AND it.status != 'VOID'
            AND it.quantity = $5::numeric
            AND (LOWER(s.symbol) = LOWER($6)
                 OR LOWER(s.symbol) LIKE LOWER($7))
          LIMIT 1`,
        [
          userId,
          input.accountId,
          input.action === "BUY" ? InvestmentAction.BUY : InvestmentAction.SELL,
          input.date,
          String(input.quantity),
          input.symbol,
          `${escapeLikePattern(input.symbol)}.%`,
        ],
      ),
    );
    return rows.length > 0;
  }
}
