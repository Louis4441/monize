import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import {
  CreateScheduledTransactionOverrideDto,
  UpdateScheduledTransactionOverrideDto,
} from "./dto/scheduled-transaction-override.dto";
import { validateSplitAmountSum } from "../common/split-amount.util";
import { tenantTx } from "../common/db/tenant-tx";
import { tr } from "../i18n/translate";

@Injectable()
export class ScheduledTransactionOverrideService {
  private readonly logger = new Logger(
    ScheduledTransactionOverrideService.name,
  );

  constructor(private dataSource: DataSource) {}

  async createOverride(
    scheduledTransactionId: string,
    createDto: CreateScheduledTransactionOverrideDto,
  ): Promise<ScheduledTransactionOverride> {
    return tenantTx(this.dataSource, async (m) => {
      const repo = m.getRepository(ScheduledTransactionOverride);
      const existing = await repo
        .createQueryBuilder("override")
        .where("override.scheduledTransactionId = :scheduledTransactionId", {
          scheduledTransactionId,
        })
        .andWhere("override.originalDate = :date", {
          date: createDto.originalDate,
        })
        .getOne();

      if (existing) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.overrideAlreadyExists",
            `An override already exists for the ${createDto.originalDate} occurrence. Use update instead.`,
            { originalDate: createDto.originalDate },
          ),
        );
      }

      if (
        createDto.isSplit &&
        createDto.splits &&
        createDto.splits.length > 0
      ) {
        if (createDto.amount === undefined || createDto.amount === null) {
          throw new BadRequestException(
            tr(
              "errors.scheduled.splitOverrideRequiresAmount",
              "Amount is required when creating split override",
            ),
          );
        }
        this.validateOverrideSplits(createDto.splits, createDto.amount);
      }

      const override = repo.create({
        scheduledTransactionId,
        originalDate: createDto.originalDate,
        overrideDate: createDto.overrideDate,
        amount: createDto.amount ?? null,
        categoryId: createDto.categoryId ?? null,
        description: createDto.description ?? null,
        isSplit: createDto.isSplit ?? null,
        splits:
          createDto.splits?.map((s) => ({
            splitKind: s.splitKind,
            categoryId: s.categoryId ?? null,
            transferAccountId: s.transferAccountId ?? null,
            investment: s.investment,
            amount: s.amount,
            memo: s.memo ?? null,
          })) ?? null,
        investmentQuantity: createDto.investmentQuantity ?? null,
        investmentPrice: createDto.investmentPrice ?? null,
        investmentTotalAmount: createDto.investmentTotalAmount ?? null,
      });

      return repo.save(override);
    });
  }

  async findOverrides(
    scheduledTransactionId: string,
  ): Promise<ScheduledTransactionOverride[]> {
    return tenantTx(this.dataSource, (m) =>
      m.getRepository(ScheduledTransactionOverride).find({
        where: { scheduledTransactionId },
        relations: ["category"],
        order: { overrideDate: "ASC" },
      }),
    );
  }

  async findOverride(
    scheduledTransactionId: string,
    overrideId: string,
  ): Promise<ScheduledTransactionOverride> {
    const override = await tenantTx(this.dataSource, (m) =>
      m.getRepository(ScheduledTransactionOverride).findOne({
        where: { id: overrideId, scheduledTransactionId },
        relations: ["category"],
      }),
    );

    if (!override) {
      throw new NotFoundException(
        tr(
          "errors.scheduled.overrideNotFound",
          `Override with ID ${overrideId} not found`,
          { overrideId },
        ),
      );
    }

    return override;
  }

  async findOverrideByDate(
    scheduledTransactionId: string,
    date: string,
  ): Promise<ScheduledTransactionOverride | null> {
    const normalizedDate = date.split("T")[0];

    this.logger.debug(
      `findOverrideByDate: Looking for override with scheduledTransactionId=${scheduledTransactionId}, date=${normalizedDate}`,
    );

    const allOverrides = await tenantTx(this.dataSource, (m) =>
      m.getRepository(ScheduledTransactionOverride).find({
        where: { scheduledTransactionId },
        relations: ["category"],
      }),
    );

    this.logger.debug(
      `findOverrideByDate: Found ${allOverrides.length} total overrides for transaction`,
    );

    const override = allOverrides.find((o) => {
      const originalDate = String(o.originalDate).split("T")[0];
      this.logger.debug(
        `findOverrideByDate: Comparing originalDate ${originalDate} with ${normalizedDate}`,
      );
      return originalDate === normalizedDate;
    });

    this.logger.debug(
      `findOverrideByDate: Result = ${override ? `found id=${override.id}` : "null"}`,
    );

    return override || null;
  }

  async updateOverride(
    scheduledTransactionId: string,
    overrideId: string,
    updateDto: UpdateScheduledTransactionOverrideDto,
  ): Promise<ScheduledTransactionOverride> {
    const override = await this.findOverride(
      scheduledTransactionId,
      overrideId,
    );

    if (updateDto.isSplit && updateDto.splits && updateDto.splits.length > 0) {
      const amount = updateDto.amount ?? override.amount;
      if (amount === null) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.updateSplitOverrideRequiresAmount",
            "Amount is required for split override",
          ),
        );
      }
      this.validateOverrideSplits(updateDto.splits, amount);
    }

    if (updateDto.amount !== undefined) override.amount = updateDto.amount;
    if (updateDto.categoryId !== undefined)
      override.categoryId = updateDto.categoryId ?? null;
    if (updateDto.description !== undefined)
      override.description = updateDto.description;
    if (updateDto.isSplit !== undefined) override.isSplit = updateDto.isSplit;
    if (updateDto.splits !== undefined) {
      override.splits =
        updateDto.splits?.map((s) => ({
          splitKind: s.splitKind,
          categoryId: s.categoryId ?? null,
          transferAccountId: s.transferAccountId ?? null,
          investment: s.investment,
          amount: s.amount,
          memo: s.memo ?? null,
        })) ?? null;
    }
    if (updateDto.investmentQuantity !== undefined)
      override.investmentQuantity = updateDto.investmentQuantity;
    if (updateDto.investmentPrice !== undefined)
      override.investmentPrice = updateDto.investmentPrice;
    if (updateDto.investmentTotalAmount !== undefined)
      override.investmentTotalAmount = updateDto.investmentTotalAmount;

    return tenantTx(this.dataSource, (m) =>
      m.getRepository(ScheduledTransactionOverride).save(override),
    );
  }

  async removeOverride(
    scheduledTransactionId: string,
    overrideId: string,
  ): Promise<void> {
    const override = await this.findOverride(
      scheduledTransactionId,
      overrideId,
    );
    await tenantTx(this.dataSource, (m) =>
      m.getRepository(ScheduledTransactionOverride).remove(override),
    );
  }

  async removeAllOverrides(scheduledTransactionId: string): Promise<number> {
    const result = await tenantTx(this.dataSource, (m) =>
      m.getRepository(ScheduledTransactionOverride).delete({
        scheduledTransactionId,
      }),
    );
    return result.affected || 0;
  }

  async hasOverrides(
    scheduledTransactionId: string,
  ): Promise<{ hasOverrides: boolean; count: number }> {
    const count = await tenantTx(this.dataSource, (m) =>
      m.getRepository(ScheduledTransactionOverride).count({
        where: { scheduledTransactionId },
      }),
    );

    return { hasOverrides: count > 0, count };
  }

  private validateOverrideSplits(
    splits: {
      categoryId?: string | null;
      amount: number;
      memo?: string | null;
    }[],
    transactionAmount: number,
  ): void {
    validateSplitAmountSum(splits, transactionAmount);
  }
}
