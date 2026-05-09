import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Cron } from "@nestjs/schedule";
import { DataSource, In, LessThanOrEqual, Repository } from "typeorm";
import { ScheduledInvestmentTransaction } from "./entities/scheduled-investment-transaction.entity";
import { CreateScheduledInvestmentTransactionDto } from "./dto/create-scheduled-investment-transaction.dto";
import { UpdateScheduledInvestmentTransactionDto } from "./dto/update-scheduled-investment-transaction.dto";
import { PostScheduledInvestmentTransactionDto } from "./dto/post-scheduled-investment-transaction.dto";
import { AccountsService } from "../accounts/accounts.service";
import { AccountType } from "../accounts/entities/account.entity";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import { InvestmentAction } from "../securities/entities/investment-transaction.entity";
import { ActionHistoryService } from "../action-history/action-history.service";
import { todayInTimezone } from "../common/date-utils";
import {
  calculateNextDueDate as calcNextDueDate,
  ensureYMD,
  FrequencyType,
} from "../common/recurrence";
import { UserPreference } from "../users/entities/user-preference.entity";

const SECURITY_REQUIRED_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.BUY,
  InvestmentAction.SELL,
  InvestmentAction.DIVIDEND,
  InvestmentAction.CAPITAL_GAIN,
  InvestmentAction.SPLIT,
  InvestmentAction.REINVEST,
  InvestmentAction.ADD_SHARES,
  InvestmentAction.REMOVE_SHARES,
]);

const QUANTITY_PRICE_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.BUY,
  InvestmentAction.SELL,
  InvestmentAction.REINVEST,
]);

const QUANTITY_ONLY_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.ADD_SHARES,
  InvestmentAction.REMOVE_SHARES,
]);

const TOTAL_AMOUNT_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.DIVIDEND,
  InvestmentAction.INTEREST,
  InvestmentAction.CAPITAL_GAIN,
  InvestmentAction.TRANSFER_IN,
  InvestmentAction.TRANSFER_OUT,
]);

export interface LlmScheduledInvestmentRow {
  id: string;
  name: string;
  accountName: string | null;
  symbol: string | null;
  action: InvestmentAction;
  frequency: FrequencyType;
  nextDueDate: string;
  autoPost: boolean;
  isActive: boolean;
  quantity: number | null;
  price: number | null;
  totalAmount: number | null;
}

@Injectable()
export class ScheduledInvestmentTransactionsService {
  private readonly logger = new Logger(
    ScheduledInvestmentTransactionsService.name,
  );

  constructor(
    @InjectRepository(ScheduledInvestmentTransaction)
    private readonly repository: Repository<ScheduledInvestmentTransaction>,
    @InjectRepository(UserPreference)
    private readonly userPreferenceRepository: Repository<UserPreference>,
    private readonly accountsService: AccountsService,
    private readonly investmentTransactionsService: InvestmentTransactionsService,
    private readonly actionHistoryService: ActionHistoryService,
    private readonly dataSource: DataSource,
  ) {}

  private async resolveTimezone(userId: string): Promise<string> {
    const pref = await this.userPreferenceRepository.findOne({
      where: { userId },
    });
    const raw = pref?.timezone?.trim();
    return raw && raw !== "browser" ? raw : "UTC";
  }

  private validateActionFields(
    dto: Partial<CreateScheduledInvestmentTransactionDto>,
  ): void {
    const { action } = dto;
    if (!action) return;

    if (SECURITY_REQUIRED_ACTIONS.has(action) && !dto.securityId) {
      throw new BadRequestException(
        `Security is required for ${action} transactions`,
      );
    }

    if (QUANTITY_PRICE_ACTIONS.has(action)) {
      if (dto.quantity === undefined || Number(dto.quantity) <= 0) {
        throw new BadRequestException(
          `Quantity is required and must be positive for ${action}`,
        );
      }
      if (dto.price === undefined || Number(dto.price) < 0) {
        throw new BadRequestException(`Price is required for ${action}`);
      }
    }

    if (QUANTITY_ONLY_ACTIONS.has(action)) {
      if (dto.quantity === undefined || Number(dto.quantity) <= 0) {
        throw new BadRequestException(
          `Quantity is required and must be positive for ${action}`,
        );
      }
    }

    if (TOTAL_AMOUNT_ACTIONS.has(action)) {
      if (dto.totalAmount === undefined) {
        throw new BadRequestException(`Total amount is required for ${action}`);
      }
    }

    if (
      action === InvestmentAction.SPLIT &&
      (dto.quantity === undefined || Number(dto.quantity) <= 0)
    ) {
      throw new BadRequestException("Split ratio (quantity) must be positive");
    }
  }

  async create(
    userId: string,
    dto: CreateScheduledInvestmentTransactionDto,
  ): Promise<ScheduledInvestmentTransaction> {
    const account = await this.accountsService.findOne(userId, dto.accountId);
    if (account.accountType !== AccountType.INVESTMENT) {
      throw new BadRequestException("Account must be of type INVESTMENT");
    }

    if (dto.fundingAccountId) {
      await this.accountsService.findOne(userId, dto.fundingAccountId);
    }

    this.validateActionFields(dto);

    const entity = this.repository.create({
      userId,
      accountId: dto.accountId,
      fundingAccountId: dto.fundingAccountId ?? null,
      securityId: dto.securityId ?? null,
      action: dto.action,
      name: dto.name,
      quantity: dto.quantity ?? null,
      price: dto.price ?? null,
      commission: dto.commission ?? 0,
      totalAmount: dto.totalAmount ?? null,
      currencyCode: dto.currencyCode ?? account.currencyCode,
      exchangeRate: dto.exchangeRate ?? null,
      description: dto.description ?? null,
      frequency: dto.frequency,
      nextDueDate: dto.nextDueDate,
      startDate: dto.startDate ?? dto.nextDueDate,
      endDate: dto.endDate ?? null,
      occurrencesRemaining: dto.occurrencesRemaining ?? null,
      totalOccurrences: dto.occurrencesRemaining ?? null,
      isActive: dto.isActive ?? true,
      autoPost: dto.autoPost ?? false,
      reminderDaysBefore: dto.reminderDaysBefore ?? 3,
    });

    const saved = await this.repository.save(entity);
    const result = await this.findOne(userId, saved.id);

    this.actionHistoryService.record(userId, {
      entityType: "scheduled_investment_transaction",
      entityId: saved.id,
      action: "create",
      afterData: { ...result },
      description: `Created scheduled investment "${dto.name}"`,
    });

    return result;
  }

  async findAll(userId: string): Promise<ScheduledInvestmentTransaction[]> {
    return this.repository.find({
      where: { userId },
      relations: ["account", "fundingAccount", "security"],
      order: { nextDueDate: "ASC" },
    });
  }

  async findUpcoming(
    userId: string,
    days: number,
  ): Promise<ScheduledInvestmentTransaction[]> {
    const tz = await this.resolveTimezone(userId);
    const today = todayInTimezone(tz) ?? new Date().toISOString().split("T")[0];
    const futureDate = calcNextDueDateNDaysOut(today, days);

    return this.repository.find({
      where: {
        userId,
        isActive: true,
        nextDueDate: lessOrEqual(futureDate),
      },
      relations: ["account", "fundingAccount", "security"],
      order: { nextDueDate: "ASC" },
    });
  }

  async findOne(
    userId: string,
    id: string,
  ): Promise<ScheduledInvestmentTransaction> {
    const found = await this.repository.findOne({
      where: { id, userId },
      relations: ["account", "fundingAccount", "security"],
    });
    if (!found) {
      throw new NotFoundException(
        `Scheduled investment transaction ${id} not found`,
      );
    }
    return found;
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateScheduledInvestmentTransactionDto,
  ): Promise<ScheduledInvestmentTransaction> {
    const existing = await this.findOne(userId, id);

    if (dto.accountId) {
      const account = await this.accountsService.findOne(userId, dto.accountId);
      if (account.accountType !== AccountType.INVESTMENT) {
        throw new BadRequestException("Account must be of type INVESTMENT");
      }
    }

    if (dto.fundingAccountId) {
      await this.accountsService.findOne(userId, dto.fundingAccountId);
    }

    this.validateActionFields({
      ...existing,
      ...dto,
    } as Partial<CreateScheduledInvestmentTransactionDto>);

    const beforeData = { ...existing };

    await this.repository.update(id, {
      ...(dto.accountId !== undefined && { accountId: dto.accountId }),
      ...(dto.fundingAccountId !== undefined && {
        fundingAccountId: dto.fundingAccountId || null,
      }),
      ...(dto.securityId !== undefined && {
        securityId: dto.securityId || null,
      }),
      ...(dto.action !== undefined && { action: dto.action }),
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.quantity !== undefined && { quantity: dto.quantity }),
      ...(dto.price !== undefined && { price: dto.price }),
      ...(dto.commission !== undefined && { commission: dto.commission }),
      ...(dto.totalAmount !== undefined && { totalAmount: dto.totalAmount }),
      ...(dto.currencyCode !== undefined && {
        currencyCode: dto.currencyCode,
      }),
      ...(dto.exchangeRate !== undefined && { exchangeRate: dto.exchangeRate }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.frequency !== undefined && { frequency: dto.frequency }),
      ...(dto.nextDueDate !== undefined && { nextDueDate: dto.nextDueDate }),
      ...(dto.startDate !== undefined && { startDate: dto.startDate }),
      ...(dto.endDate !== undefined && { endDate: dto.endDate || null }),
      ...(dto.occurrencesRemaining !== undefined && {
        occurrencesRemaining: dto.occurrencesRemaining,
      }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      ...(dto.autoPost !== undefined && { autoPost: dto.autoPost }),
      ...(dto.reminderDaysBefore !== undefined && {
        reminderDaysBefore: dto.reminderDaysBefore,
      }),
    });

    const result = await this.findOne(userId, id);

    this.actionHistoryService.record(userId, {
      entityType: "scheduled_investment_transaction",
      entityId: id,
      action: "update",
      beforeData,
      afterData: { ...result },
      description: `Updated scheduled investment "${result.name}"`,
    });

    return result;
  }

  async remove(userId: string, id: string): Promise<void> {
    const existing = await this.findOne(userId, id);
    await this.repository.delete({ id, userId });

    this.actionHistoryService.record(userId, {
      entityType: "scheduled_investment_transaction",
      entityId: id,
      action: "delete",
      beforeData: { ...existing },
      description: `Deleted scheduled investment "${existing.name}"`,
    });
  }

  async skip(
    userId: string,
    id: string,
  ): Promise<ScheduledInvestmentTransaction> {
    const existing = await this.findOne(userId, id);
    const newDue = calcNextDueDate(
      ensureYMD(existing.nextDueDate),
      existing.frequency,
    );
    await this.advanceSchedule(existing, newDue);
    return this.findOne(userId, id);
  }

  async post(
    userId: string,
    id: string,
    postDto?: PostScheduledInvestmentTransactionDto,
  ): Promise<ScheduledInvestmentTransaction | null> {
    const scheduled = await this.findOne(userId, id);
    const tz = await this.resolveTimezone(userId);

    const transactionDate =
      postDto?.transactionDate ?? ensureYMD(scheduled.nextDueDate);

    const finalQuantity =
      postDto?.quantity !== undefined
        ? postDto.quantity
        : (scheduled.quantity ?? undefined);
    const finalPrice =
      postDto?.price !== undefined
        ? postDto.price
        : (scheduled.price ?? undefined);
    const finalTotalAmount =
      postDto?.totalAmount !== undefined
        ? postDto.totalAmount
        : (scheduled.totalAmount ?? undefined);

    await this.investmentTransactionsService.create(userId, {
      accountId: scheduled.accountId,
      action: scheduled.action,
      transactionDate,
      securityId: scheduled.securityId ?? undefined,
      fundingAccountId: scheduled.fundingAccountId ?? undefined,
      quantity:
        finalQuantity !== undefined && finalQuantity !== null
          ? Number(finalQuantity)
          : TOTAL_AMOUNT_ACTIONS.has(scheduled.action) &&
              finalTotalAmount !== undefined &&
              finalTotalAmount !== null
            ? 1
            : undefined,
      price:
        finalPrice !== undefined && finalPrice !== null
          ? Number(finalPrice)
          : TOTAL_AMOUNT_ACTIONS.has(scheduled.action) &&
              finalTotalAmount !== undefined &&
              finalTotalAmount !== null
            ? Number(finalTotalAmount)
            : undefined,
      commission:
        scheduled.commission !== null && scheduled.commission !== undefined
          ? Number(scheduled.commission)
          : 0,
      exchangeRate:
        scheduled.exchangeRate !== null && scheduled.exchangeRate !== undefined
          ? Number(scheduled.exchangeRate)
          : undefined,
      description: scheduled.description ?? undefined,
    });

    const today = todayInTimezone(tz);

    if (scheduled.frequency === "ONCE") {
      await this.repository.delete({ id, userId });
      return null;
    }

    const newDue = calcNextDueDate(
      ensureYMD(scheduled.nextDueDate),
      scheduled.frequency,
    );
    await this.advanceSchedule(scheduled, newDue, today ?? undefined);

    return this.findOne(userId, id);
  }

  private async advanceSchedule(
    scheduled: ScheduledInvestmentTransaction,
    newNextDueDate: string,
    today?: string,
  ): Promise<void> {
    const updateFields: Record<string, unknown> = {
      nextDueDate: newNextDueDate,
      lastPostedDate: today ?? ensureYMD(scheduled.nextDueDate),
    };

    if (
      scheduled.occurrencesRemaining !== null &&
      scheduled.occurrencesRemaining > 0
    ) {
      const newRemaining = scheduled.occurrencesRemaining - 1;
      updateFields.occurrencesRemaining = newRemaining;
      if (newRemaining === 0) {
        updateFields.isActive = false;
      }
    }

    if (scheduled.endDate && newNextDueDate > ensureYMD(scheduled.endDate)) {
      updateFields.isActive = false;
    }

    await this.repository.update(scheduled.id, updateFields);
  }

  @Cron("10 * * * *")
  async processAutoPost(): Promise<void> {
    this.logger.log("Starting auto-post for scheduled investments");

    try {
      const userRows: { user_id: string; timezone: string | null }[] =
        await this.dataSource.query(
          `SELECT u.id as user_id, p.timezone
             FROM users u
             LEFT JOIN user_preferences p ON p.user_id = u.id`,
        );

      if (userRows.length === 0) return;

      const userIdsByTz = new Map<string, string[]>();
      for (const { user_id, timezone } of userRows) {
        const normalised = timezone?.trim();
        const tz = normalised && normalised !== "browser" ? normalised : "UTC";
        const list = userIdsByTz.get(tz) ?? [];
        list.push(user_id);
        userIdsByTz.set(tz, list);
      }

      let success = 0;
      let failure = 0;

      for (const [tz, userIds] of userIdsByTz) {
        const today = todayInTimezone(tz);
        if (!today) {
          this.logger.warn(
            `Skipping ${userIds.length} user(s) with invalid timezone "${tz}"`,
          );
          continue;
        }

        const due = await this.repository.find({
          where: {
            userId: In(userIds),
            isActive: true,
            autoPost: true,
            nextDueDate: LessThanOrEqual(today),
          },
          order: { nextDueDate: "ASC" },
        });

        for (const row of due) {
          try {
            await this.post(row.userId, row.id);
            success++;
          } catch (error) {
            failure++;
            this.logger.error(
              `Failed to auto-post "${row.name}" (${row.id}): ${
                error instanceof Error ? error.message : String(error)
              }`,
              error instanceof Error ? error.stack : undefined,
            );
          }
        }
      }

      this.logger.log(
        `Auto-post complete: ${success} succeeded, ${failure} failed`,
      );
    } catch (error) {
      this.logger.error(
        "Auto-post processing failed",
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async getLlmUpcoming(
    userId: string,
    days: number = 30,
  ): Promise<LlmScheduledInvestmentRow[]> {
    const rows = await this.findUpcoming(userId, days);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      accountName: r.account?.name ?? null,
      symbol: r.security?.symbol ?? null,
      action: r.action,
      frequency: r.frequency,
      nextDueDate: ensureYMD(r.nextDueDate),
      autoPost: r.autoPost,
      isActive: r.isActive,
      quantity: r.quantity,
      price: r.price,
      totalAmount: r.totalAmount,
    }));
  }
}

function lessOrEqual(value: string) {
  return LessThanOrEqual(value) as any;
}

function calcNextDueDateNDaysOut(today: string, days: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1, d + days));
  const ny = target.getUTCFullYear();
  const nm = String(target.getUTCMonth() + 1).padStart(2, "0");
  const nd = String(target.getUTCDate()).padStart(2, "0");
  return `${ny}-${nm}-${nd}`;
}
