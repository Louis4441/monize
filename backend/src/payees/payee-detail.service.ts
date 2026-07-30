import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { roundMoney } from "../common/round.util";
import { Account } from "../accounts/entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { PayeeAlias } from "./entities/payee-alias.entity";
import { PayeesService } from "./payees.service";
import { countUncategorizedTransactionsForPayee } from "./payee-backfill.util";
import {
  PayeeAccountBreakdownRow,
  PayeeDetailDto,
  PayeeDetailStats,
  PayeeLargestTransaction,
} from "./dto/payee-detail.dto";

/**
 * The transaction scope every figure in this service is computed over: real
 * rows only. Void transactions never happened, and a split parent's amount is
 * carried by the parent row itself (children are excluded so nothing counts
 * twice). This mirrors the analytics service's scope, so the counts here agree
 * with the summary and grouped-totals endpoints the detail page also calls.
 */
function realTransactionScope(qb: ReturnType<EntityManager["createQueryBuilder"]>) {
  return qb
    .andWhere("t.status != 'VOID'")
    .andWhere("t.parent_transaction_id IS NULL");
}

/**
 * The facts the payee detail page needs that no generic analytics endpoint can
 * produce: lifetime first/last dates, the per-account breakdown, the largest
 * transaction, and the payee's own housekeeping counts.
 *
 * Deliberately identity-and-facts only. Spending over time, category
 * breakdowns and recurring cadence all come from the transactions analytics
 * endpoints, which already accept a payee filter -- recomputing any of that
 * here would let this page drift from the register and the reports. Currency
 * conversion is likewise absent on purpose: every amount is in the currency of
 * the row it came from, and the client owns display currency.
 */
@Injectable()
export class PayeeDetailService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly payeesService: PayeesService,
  ) {}

  async getDetail(userId: string, payeeId: string): Promise<PayeeDetailDto> {
    // Validates ownership and existence (localized 404), loads defaultCategory.
    const payee = await this.payeesService.findOne(userId, payeeId);

    return withScopedDb(this.dataSource, async (m) => {
      const [stats, accounts, largestTransaction, overpaymentForAccounts] =
        await Promise.all([
          this.getStats(m, userId, payeeId),
          this.getAccountBreakdown(m, userId, payeeId),
          this.getLargestTransaction(m, userId, payeeId),
          this.getOverpaymentAccounts(m, userId, payeeId),
        ]);

      return {
        payee,
        stats,
        accounts,
        largestTransaction,
        overpaymentForAccounts,
      };
    });
  }

  private async getStats(
    m: EntityManager,
    userId: string,
    payeeId: string,
  ): Promise<PayeeDetailStats> {
    const row = await realTransactionScope(
      m
        .createQueryBuilder(Transaction, "t")
        .select("COUNT(*)", "count")
        .addSelect("MIN(t.transaction_date)", "first")
        .addSelect("MAX(t.transaction_date)", "last")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.payee_id = :payeeId", { payeeId }),
    ).getRawOne<{ count: string; first: string | null; last: string | null }>();

    const [uncategorizedCount, aliasCount] = await Promise.all([
      countUncategorizedTransactionsForPayee(m, userId, payeeId),
      m.getRepository(PayeeAlias).count({ where: { userId, payeeId } }),
    ]);

    return {
      transactionCount: parseInt(row?.count ?? "0", 10),
      firstTransactionDate: row?.first ?? null,
      lastTransactionDate: row?.last ?? null,
      uncategorizedCount,
      aliasCount,
    };
  }

  private async getAccountBreakdown(
    m: EntityManager,
    userId: string,
    payeeId: string,
  ): Promise<PayeeAccountBreakdownRow[]> {
    const rows = await realTransactionScope(
      m
        .createQueryBuilder(Transaction, "t")
        .innerJoin(Account, "account", "account.id = t.account_id")
        .select("account.id", "accountId")
        .addSelect("account.name", "accountName")
        .addSelect("account.account_type", "accountType")
        .addSelect("account.currency_code", "currencyCode")
        .addSelect("COUNT(*)", "transactionCount")
        .addSelect("SUM(t.amount)", "total")
        .addSelect("MAX(t.transaction_date)", "lastTransactionDate")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.payee_id = :payeeId", { payeeId }),
    )
      .groupBy("account.id")
      .addGroupBy("account.name")
      .addGroupBy("account.account_type")
      .addGroupBy("account.currency_code")
      .orderBy("COUNT(*)", "DESC")
      .getRawMany<{
        accountId: string;
        accountName: string;
        accountType: string;
        currencyCode: string;
        transactionCount: string;
        total: string;
        lastTransactionDate: string | null;
      }>();

    return rows.map((row) => ({
      accountId: row.accountId,
      accountName: row.accountName,
      accountType: row.accountType,
      currencyCode: row.currencyCode,
      transactionCount: parseInt(row.transactionCount, 10),
      total: roundMoney(Number(row.total)),
      lastTransactionDate: row.lastTransactionDate ?? null,
    }));
  }

  private async getLargestTransaction(
    m: EntityManager,
    userId: string,
    payeeId: string,
  ): Promise<PayeeLargestTransaction | null> {
    const row = await realTransactionScope(
      m
        .createQueryBuilder(Transaction, "t")
        .innerJoin(Account, "account", "account.id = t.account_id")
        .select("t.id", "id")
        .addSelect("t.transaction_date", "transactionDate")
        .addSelect("t.amount", "amount")
        .addSelect("t.currency_code", "currencyCode")
        .addSelect("t.description", "description")
        .addSelect("account.id", "accountId")
        .addSelect("account.name", "accountName")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.payee_id = :payeeId", { payeeId }),
    )
      .orderBy("ABS(t.amount)", "DESC")
      .addOrderBy("t.transaction_date", "DESC")
      .limit(1)
      .getRawOne<{
        id: string;
        transactionDate: string;
        amount: string;
        currencyCode: string;
        description: string | null;
        accountId: string;
        accountName: string;
      }>();

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      transactionDate: row.transactionDate,
      amount: roundMoney(Number(row.amount)),
      currencyCode: row.currencyCode,
      accountId: row.accountId,
      accountName: row.accountName,
      description: row.description ?? null,
    };
  }

  private async getOverpaymentAccounts(
    m: EntityManager,
    userId: string,
    payeeId: string,
  ): Promise<{ accountId: string; accountName: string }[]> {
    const rows = await m.getRepository(Account).find({
      where: { userId, overpaymentPayeeId: payeeId },
      select: ["id", "name"],
      order: { name: "ASC" },
    });
    return rows.map((account) => ({
      accountId: account.id,
      accountName: account.name,
    }));
  }
}
