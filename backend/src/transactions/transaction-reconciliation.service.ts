import {
  Injectable,
  BadRequestException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { AccountsService } from "../accounts/accounts.service";
import {
  isTransactionInFuture,
  formatDateYMDLocal,
} from "../common/date-utils";
import { tr } from "../i18n/translate";
import { tenantTx } from "../common/db/tenant-tx";

@Injectable()
export class TransactionReconciliationService {
  constructor(
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    private dataSource: DataSource,
  ) {}

  async updateStatus(
    transaction: Transaction,
    status: TransactionStatus,
    userId: string,
    triggerNetWorthRecalc: (accountId: string, userId: string) => void,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<Transaction> {
    const oldStatus = transaction.status;
    const wasVoid = oldStatus === TransactionStatus.VOID;
    const isVoid = status === TransactionStatus.VOID;

    // The status change and the matching balance adjustment touch two tables
    // (transactions + accounts) and must commit atomically, otherwise a failure
    // between the two leaves the account balance out of sync with the status.
    await tenantTx(this.dataSource, async (m) => {
      if (isTransactionInFuture(transaction.transactionDate)) {
        await m.update(Transaction, transaction.id, {
          status,
        });
        if (wasVoid !== isVoid) {
          await this.accountsService.recalculateCurrentBalance(
            transaction.accountId,
          );
        }
      } else {
        if (wasVoid && !isVoid) {
          await this.accountsService.updateBalance(
            transaction.accountId,
            Number(transaction.amount),
          );
        } else if (!wasVoid && isVoid) {
          await this.accountsService.updateBalance(
            transaction.accountId,
            -Number(transaction.amount),
          );
        }
        await m.update(Transaction, transaction.id, {
          status,
        });
      }

      if (
        status === TransactionStatus.RECONCILED &&
        oldStatus !== TransactionStatus.RECONCILED
      ) {
        const reconciledDate = formatDateYMDLocal(new Date());
        await m.update(Transaction, transaction.id, {
          reconciledDate,
        });
      }
    });

    if (wasVoid !== isVoid) {
      triggerNetWorthRecalc(transaction.accountId, userId);
    }

    return findOne(userId, transaction.id);
  }

  async markCleared(
    transaction: Transaction,
    isCleared: boolean,
    userId: string,
    triggerNetWorthRecalc: (accountId: string, userId: string) => void,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<Transaction> {
    if (
      transaction.status === TransactionStatus.RECONCILED ||
      transaction.status === TransactionStatus.VOID
    ) {
      throw new BadRequestException(
        tr(
          "errors.transactions.cannotChangeClearedStatusOfReconciledOrVoid",
          "Cannot change cleared status of reconciled or void transactions",
        ),
      );
    }

    const newStatus = isCleared
      ? TransactionStatus.CLEARED
      : TransactionStatus.UNRECONCILED;
    return this.updateStatus(
      transaction,
      newStatus,
      userId,
      triggerNetWorthRecalc,
      findOne,
    );
  }

  async reconcile(
    transaction: Transaction,
    userId: string,
    triggerNetWorthRecalc: (accountId: string, userId: string) => void,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<Transaction> {
    if (transaction.status === TransactionStatus.RECONCILED) {
      throw new BadRequestException(
        tr(
          "errors.transactions.alreadyReconciled",
          "Transaction is already reconciled",
        ),
      );
    }

    if (transaction.status === TransactionStatus.VOID) {
      throw new BadRequestException(
        tr(
          "errors.transactions.cannotReconcileVoid",
          "Cannot reconcile a void transaction",
        ),
      );
    }

    return this.updateStatus(
      transaction,
      TransactionStatus.RECONCILED,
      userId,
      triggerNetWorthRecalc,
      findOne,
    );
  }

  async unreconcile(
    transaction: Transaction,
    userId: string,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<Transaction> {
    if (transaction.status !== TransactionStatus.RECONCILED) {
      throw new BadRequestException(
        tr(
          "errors.transactions.notReconciled",
          "Transaction is not reconciled",
        ),
      );
    }

    await tenantTx(this.dataSource, (m) =>
      m.getRepository(Transaction).update(transaction.id, {
        status: TransactionStatus.CLEARED,
        reconciledDate: null,
      }),
    );

    return findOne(userId, transaction.id);
  }

  async getReconciliationData(
    userId: string,
    accountId: string,
    statementDate: string,
    statementBalance: number,
  ): Promise<{
    transactions: Transaction[];
    reconciledBalance: number;
    clearedBalance: number;
    difference: number;
  }> {
    const [account, transactions, reconciledResult, clearedResult] =
      await tenantTx(this.dataSource, (m) =>
        Promise.all([
          this.accountsService.findOne(userId, accountId),
          m
            .getRepository(Transaction)
            .createQueryBuilder("transaction")
            .leftJoinAndSelect("transaction.payee", "payee")
            .leftJoinAndSelect("transaction.category", "category")
            .where("transaction.userId = :userId", { userId })
            .andWhere("transaction.accountId = :accountId", { accountId })
            .andWhere("transaction.parentTransactionId IS NULL")
            .andWhere("transaction.status IN (:...statuses)", {
              statuses: [
                TransactionStatus.UNRECONCILED,
                TransactionStatus.CLEARED,
              ],
            })
            .andWhere("transaction.transactionDate <= :statementDate", {
              statementDate,
            })
            .orderBy("transaction.transactionDate", "ASC")
            .addOrderBy("transaction.createdAt", "ASC")
            .getMany(),
          m
            .getRepository(Transaction)
            .createQueryBuilder("transaction")
            .select("SUM(transaction.amount)", "sum")
            .where("transaction.userId = :userId", { userId })
            .andWhere("transaction.accountId = :accountId", { accountId })
            .andWhere("transaction.parentTransactionId IS NULL")
            .andWhere("transaction.status = :status", {
              status: TransactionStatus.RECONCILED,
            })
            .getRawOne(),
          m
            .getRepository(Transaction)
            .createQueryBuilder("transaction")
            .select("SUM(transaction.amount)", "sum")
            .where("transaction.userId = :userId", { userId })
            .andWhere("transaction.accountId = :accountId", { accountId })
            .andWhere("transaction.parentTransactionId IS NULL")
            .andWhere("transaction.status = :status", {
              status: TransactionStatus.CLEARED,
            })
            .andWhere("transaction.transactionDate <= :statementDate", {
              statementDate,
            })
            .getRawOne(),
        ]),
      );

    const reconciledSum = Number(reconciledResult?.sum) || 0;
    const reconciledBalance = Number(account.openingBalance) + reconciledSum;

    const clearedSum = Number(clearedResult?.sum) || 0;
    const clearedBalance = reconciledBalance + clearedSum;

    const difference = statementBalance - clearedBalance;

    return {
      transactions,
      reconciledBalance,
      clearedBalance,
      difference,
    };
  }

  async bulkReconcile(
    userId: string,
    accountId: string,
    transactionIds: string[],
    reconciledDate: string,
  ): Promise<{ reconciled: number }> {
    await this.accountsService.findOne(userId, accountId);

    if (transactionIds.length === 0) {
      return { reconciled: 0 };
    }

    return tenantTx(this.dataSource, async (m) => {
      const transactions = await m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .where("transaction.id IN (:...ids)", { ids: transactionIds })
        .andWhere("transaction.userId = :userId", { userId })
        .andWhere("transaction.accountId = :accountId", { accountId })
        .getMany();

      if (transactions.length !== transactionIds.length) {
        throw new BadRequestException(
          tr(
            "errors.transactions.bulkReconcileNotFound",
            "Some transactions were not found or do not belong to the specified account",
          ),
        );
      }

      const voidTransactions = transactions.filter(
        (t) => t.status === TransactionStatus.VOID,
      );
      if (voidTransactions.length > 0) {
        throw new BadRequestException(
          tr(
            "errors.transactions.cannotReconcileVoidPlural",
            "Cannot reconcile void transactions",
          ),
        );
      }

      await m
        .getRepository(Transaction)
        .createQueryBuilder()
        .update(Transaction)
        .set({
          status: TransactionStatus.RECONCILED,
          reconciledDate: reconciledDate,
        })
        .where("id IN (:...ids)", { ids: transactionIds })
        .andWhere("userId = :userId", { userId })
        .execute();

      return { reconciled: transactions.length };
    });
  }
}
