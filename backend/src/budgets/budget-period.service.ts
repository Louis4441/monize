import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Budget } from "./entities/budget.entity";
import { RolloverType } from "./entities/budget-category.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { BudgetPeriodCategory } from "./entities/budget-period-category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { BudgetsService } from "./budgets.service";
import { getCurrentMonthPeriodDates } from "./budget-date.utils";
import { roundMoney, sumMoney } from "../common/round.util";

@Injectable()
export class BudgetPeriodService {
  constructor(
    private budgetsService: BudgetsService,
    private dataSource: DataSource,
  ) {}

  async findAll(userId: string, budgetId: string): Promise<BudgetPeriod[]> {
    await this.budgetsService.findOne(userId, budgetId);

    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetPeriod).find({
        where: { budgetId },
        order: { periodStart: "DESC" },
      }),
    );
  }

  async findOne(
    userId: string,
    budgetId: string,
    periodId: string,
  ): Promise<BudgetPeriod> {
    await this.budgetsService.findOne(userId, budgetId);

    const period = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetPeriod).findOne({
        where: { id: periodId, budgetId },
        relations: [
          "periodCategories",
          "periodCategories.budgetCategory",
          "periodCategories.category",
        ],
      }),
    );

    if (!period) {
      throw new NotFoundException(
        tr(
          "errors.budgets.periodNotFound",
          `Budget period with ID ${periodId} not found`,
          { id: periodId },
        ),
      );
    }

    return period;
  }

  async closePeriod(userId: string, budgetId: string): Promise<BudgetPeriod> {
    const budget = await this.budgetsService.findOne(userId, budgetId);

    const openPeriod = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetPeriod).findOne({
        where: { budgetId, status: PeriodStatus.OPEN },
        relations: ["periodCategories"],
      }),
    );

    if (!openPeriod) {
      throw new BadRequestException(
        tr("errors.budgets.noOpenPeriod", "No open period to close"),
      );
    }

    const actuals = await this.computePeriodActuals(
      userId,
      budget,
      openPeriod.periodStart,
      openPeriod.periodEnd,
    );

    // M26: the whole period close is one transaction, so a partial failure can
    // never leave a period half-closed.
    return withScopedDb(this.dataSource, async (manager) => {
      let totalIncome = 0;
      let totalExpenses = 0;

      for (const pc of openPeriod.periodCategories) {
        const actual = actuals.get(pc.budgetCategoryId) || 0;
        pc.actualAmount = actual;

        const rollover = this.computeRollover(pc, actual);
        pc.rolloverOut = rollover;

        const bcEntry = budget.categories?.find(
          (c) => c.id === pc.budgetCategoryId,
        );
        if (bcEntry?.isIncome) {
          totalIncome += actual;
        } else {
          totalExpenses += actual;
        }

        await manager.save(BudgetPeriodCategory, pc);
      }

      openPeriod.actualIncome = totalIncome;
      openPeriod.actualExpenses = totalExpenses;
      openPeriod.status = PeriodStatus.CLOSED;

      const closedPeriod = await manager.save(BudgetPeriod, openPeriod);

      await this.createNextPeriod(budget, openPeriod, manager);

      return closedPeriod;
    });
  }

  async getOrCreateCurrentPeriod(
    userId: string,
    budgetId: string,
  ): Promise<BudgetPeriod> {
    const budget = await this.budgetsService.findOne(userId, budgetId);

    const existingOpen = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetPeriod).findOne({
        where: { budgetId, status: PeriodStatus.OPEN },
        relations: ["periodCategories"],
      }),
    );

    if (existingOpen) {
      return existingOpen;
    }

    return this.createPeriodForBudget(budget);
  }

  /**
   * @param manager the caller's transaction when the new period must commit
   *   with the close that produced it; otherwise a scoped one is opened here.
   */
  async createPeriodForBudget(
    budget: Budget,
    rolloverMap?: Map<string, number>,
    manager?: EntityManager,
  ): Promise<BudgetPeriod> {
    const { periodStart, periodEnd } = getCurrentMonthPeriodDates();

    const budgetCategories = budget.categories || [];

    const totalBudgeted = sumMoney(
      budgetCategories
        .filter((bc) => !bc.isIncome)
        .map((bc) => Number(bc.amount)),
    );

    const write = async (m: EntityManager): Promise<BudgetPeriod> => {
      const periodsRepo = m.getRepository(BudgetPeriod);
      const periodCatsRepo = m.getRepository(BudgetPeriodCategory);

      const period = periodsRepo.create({
        budgetId: budget.id,
        periodStart,
        periodEnd,
        totalBudgeted,
        status: PeriodStatus.OPEN,
      });

      const savedPeriod = await periodsRepo.save(period);

      const periodCategories = budgetCategories.map((bc) => {
        const rolloverIn = rolloverMap?.get(bc.id) || 0;
        const budgetedAmount = Number(bc.amount);
        const effectiveBudget = budgetedAmount + rolloverIn;

        return periodCatsRepo.create({
          budgetPeriodId: savedPeriod.id,
          budgetCategoryId: bc.id,
          categoryId: bc.categoryId,
          budgetedAmount,
          rolloverIn,
          effectiveBudget,
          actualAmount: 0,
          rolloverOut: 0,
        });
      });

      if (periodCategories.length > 0) {
        await periodCatsRepo.save(periodCategories);
      }

      return savedPeriod;
    };

    return manager ? write(manager) : withScopedDb(this.dataSource, write);
  }

  computeRollover(
    periodCategory: BudgetPeriodCategory,
    actualAmount: number,
  ): number {
    const budgetCategory = periodCategory.budgetCategory;
    if (!budgetCategory || budgetCategory.rolloverType === RolloverType.NONE) {
      return 0;
    }

    const effectiveBudget = Number(periodCategory.effectiveBudget);
    const unused = effectiveBudget - actualAmount;

    if (unused <= 0) {
      return 0;
    }

    let rollover = unused;

    if (
      budgetCategory.rolloverCap !== null &&
      budgetCategory.rolloverCap !== undefined
    ) {
      rollover = Math.min(rollover, Number(budgetCategory.rolloverCap));
    }

    return roundMoney(rollover);
  }

  private async createNextPeriod(
    budget: Budget,
    closedPeriod: BudgetPeriod,
    manager?: EntityManager,
  ): Promise<BudgetPeriod> {
    const rolloverMap = new Map<string, number>();

    if (closedPeriod.periodCategories) {
      for (const pc of closedPeriod.periodCategories) {
        if (pc.rolloverOut > 0) {
          rolloverMap.set(pc.budgetCategoryId, Number(pc.rolloverOut));
        }
      }
    }

    return this.createPeriodForBudget(budget, rolloverMap, manager);
  }

  private async computePeriodActuals(
    userId: string,
    budget: Budget,
    periodStart: string,
    periodEnd: string,
  ): Promise<Map<string, number>> {
    const budgetCategories = budget.categories || [];
    const categoryIds = budgetCategories
      .filter((bc) => bc.categoryId !== null && !bc.isTransfer)
      .map((bc) => bc.categoryId as string);

    const result = new Map<string, number>();

    const spendingByCategoryId = new Map<string, number>();

    if (categoryIds.length > 0) {
      const directSpending = await withScopedDb(this.dataSource, (m) =>
        m
          .getRepository(Transaction)
          .createQueryBuilder("t")
          .select("t.category_id", "categoryId")
          .addSelect("COALESCE(SUM(t.amount), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
          .andWhere("t.transaction_date >= :periodStart", { periodStart })
          .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .andWhere("t.is_split = false")
          .groupBy("t.category_id")
          .getRawMany(),
      );

      for (const row of directSpending) {
        spendingByCategoryId.set(row.categoryId, parseFloat(row.total || "0"));
      }

      const splitSpending = await withScopedDb(this.dataSource, (m) =>
        m
          .getRepository(TransactionSplit)
          .createQueryBuilder("s")
          .innerJoin("s.transaction", "t")
          .select("s.category_id", "categoryId")
          .addSelect("COALESCE(SUM(s.amount), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
          .andWhere("t.transaction_date >= :periodStart", { periodStart })
          .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .groupBy("s.category_id")
          .getRawMany(),
      );

      for (const row of splitSpending) {
        const existing = spendingByCategoryId.get(row.categoryId) || 0;
        spendingByCategoryId.set(
          row.categoryId,
          existing + parseFloat(row.total || "0"),
        );
      }
    }

    // Transfer actuals
    const transferBudgetCategories = budgetCategories.filter(
      (bc) => bc.isTransfer && bc.transferAccountId,
    );
    const transferSpendingMap = new Map<string, number>();

    if (transferBudgetCategories.length > 0) {
      const transferAccountIds = transferBudgetCategories.map(
        (bc) => bc.transferAccountId as string,
      );

      const transferActuals = await withScopedDb(this.dataSource, (m) =>
        m
          .getRepository(Transaction)
          .createQueryBuilder("t")
          .innerJoin("t.linkedTransaction", "lt")
          .select("lt.account_id", "destinationAccountId")
          .addSelect("COALESCE(ABS(SUM(t.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.is_transfer = true")
          .andWhere("t.amount < 0")
          .andWhere("lt.account_id IN (:...transferAccountIds)", {
            transferAccountIds,
          })
          .andWhere("t.transaction_date >= :periodStart", { periodStart })
          .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .groupBy("lt.account_id")
          .getRawMany(),
      );

      for (const row of transferActuals) {
        transferSpendingMap.set(
          row.destinationAccountId,
          parseFloat(row.total || "0"),
        );
      }
    }

    for (const bc of budgetCategories) {
      if (bc.isTransfer && bc.transferAccountId) {
        const amount = transferSpendingMap.get(bc.transferAccountId) || 0;
        result.set(bc.id, amount);
      } else if (bc.categoryId) {
        const raw = spendingByCategoryId.get(bc.categoryId) || 0;
        const amount = bc.isIncome ? Math.max(raw, 0) : Math.max(-raw, 0);
        result.set(bc.id, amount);
      }
    }

    return result;
  }
}
