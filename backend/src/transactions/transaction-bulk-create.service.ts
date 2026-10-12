import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { QueryFailedError } from "typeorm";
import { orderByDateStable } from "../common/date-order.util";
import { CrossOwnerAccessService } from "../delegation/cross-owner-access.service";
import { tr } from "../i18n/translate";
import {
  BulkCreateItemDto,
  BulkCreateTransactionsDto,
} from "./dto/bulk-create.dto";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { JointRegisterService } from "./joint-register.service";
import { TransactionsService } from "./transactions.service";
import { TransferActor } from "./transaction-transfer.service";

export type BulkCreateRowStatus = "created" | "existing" | "failed";

/** Why a row was not created: what `POST /transactions` would have answered. */
export interface BulkCreateRowError {
  statusCode: number;
  message: string | string[];
  errorCode?: string;
}

export interface BulkCreateRowResult {
  /** The row's position in the request's `items`, 0-based. */
  index: number;
  kind: "transaction" | "transfer";
  status: BulkCreateRowStatus;
  /** The transaction's id; for a transfer, the source leg's. Absent when failed. */
  id?: string;
  /** A transfer's destination leg. */
  linkedTransactionId?: string;
  error?: BulkCreateRowError;
}

export interface BulkCreateTransactionsResult {
  created: number;
  existing: number;
  failed: number;
  /** One per item, in the request's order. */
  results: BulkCreateRowResult[];
}

/**
 * `POST /transactions/bulk` (issue #1713): many creates in one request, each
 * through the same service call its single-row route makes, so a row is
 * validated, authorized, ruled and balanced exactly as it would be on its
 * own.
 *
 * Each row commits in its own transaction, and one that fails is reported in
 * its result rather than undoing the rows before it. That is what makes the
 * batch safe to repeat: a row carrying an `externalId` that already committed
 * comes back `existing` (`transaction-external-id.ts`), so a client whose
 * request timed out sends the same batch again. One transaction around every
 * row would buy nothing a retry does not already give, and would run each
 * row's post-commit work (net-worth recalculation, loan template repricing)
 * inside it instead of after it.
 *
 * Rows are written in date order, as every import inserts its rows
 * (`orderByDateStable`), so a rule settling loan installments folds forward
 * through time; the results are still reported by the request's index.
 */
@Injectable()
export class TransactionBulkCreateService {
  private readonly logger = new Logger(TransactionBulkCreateService.name);

  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly crossOwnerAccess: CrossOwnerAccessService,
    private readonly jointRegister: JointRegisterService,
  ) {}

  async createMany(
    actor: TransferActor,
    dto: BulkCreateTransactionsDto,
  ): Promise<BulkCreateTransactionsResult> {
    const ordered = orderByDateStable(
      dto.items,
      (item) =>
        item.transaction?.transactionDate ??
        item.transfer?.transactionDate ??
        "",
    );

    const results: BulkCreateRowResult[] = [];
    for (const { row, position } of ordered) {
      results.push(await this.createRow(actor, row, position - 1));
    }
    results.sort((a, b) => a.index - b.index);

    const count = (status: BulkCreateRowStatus) =>
      results.filter((r) => r.status === status).length;
    return {
      created: count("created"),
      existing: count("existing"),
      failed: count("failed"),
      results,
    };
  }

  private async createRow(
    actor: TransferActor,
    item: BulkCreateItemDto,
    index: number,
  ): Promise<BulkCreateRowResult> {
    const kind = item.transfer ? "transfer" : "transaction";
    try {
      if (item.transaction && item.transfer) {
        throw new BadRequestException(
          tr(
            "errors.transactions.bulkItemBothKinds",
            "A bulk row carries either a transaction or a transfer, not both",
          ),
        );
      }
      if (item.transfer) {
        const { transfer, created } =
          await this.transactionsService.createTransferWithOutcome(
            actor.effectiveUserId,
            item.transfer,
            actor,
          );
        return {
          index,
          kind,
          status: created ? "created" : "existing",
          id: transfer.fromTransaction.id,
          linkedTransactionId: transfer.toTransaction.id,
        };
      }
      const { transaction, created } = await this.createTransaction(
        actor,
        item.transaction as CreateTransactionDto,
      );
      return {
        index,
        kind,
        status: created ? "created" : "existing",
        id: transaction.id,
      };
    } catch (error) {
      return { index, kind, status: "failed", error: this.rowError(error) };
    }
  }

  /**
   * The routing `TransactionsController.create` applies in the caller's own
   * context: an account the caller owns is written as the caller, any other
   * through the joint register, which authorizes the grant and writes as the
   * owner. Acting delegates never reach here (the route is not delegable).
   */
  private async createTransaction(
    actor: TransferActor,
    dto: CreateTransactionDto,
  ) {
    const owned = await this.crossOwnerAccess.isAccountOwnedBy(
      dto.accountId,
      actor.effectiveUserId,
    );
    return owned
      ? this.transactionsService.createWithOutcome(actor.effectiveUserId, dto, {
          actorIsNotOwner: false,
        })
      : this.jointRegister.createWithOutcome(actor.realUserId, dto);
  }

  /**
   * The status and message the single-row route would have answered with,
   * mapped as `GlobalExceptionFilter` maps them. Anything that is not a
   * client error is logged and reported without its detail.
   */
  private rowError(error: unknown): BulkCreateRowError {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (typeof response === "object" && response !== null) {
        const body = response as Record<string, unknown>;
        return {
          statusCode: error.getStatus(),
          message: (body.message as string | string[]) || error.message,
          ...(typeof body.errorCode === "string"
            ? { errorCode: body.errorCode }
            : {}),
        };
      }
      return { statusCode: error.getStatus(), message: error.message };
    }
    if (error instanceof QueryFailedError) {
      const code = (error.driverError as { code?: string } | undefined)?.code;
      if (code === "23505") {
        return {
          statusCode: HttpStatus.CONFLICT,
          message: tr(
            "errors.http.duplicateRecord",
            "A record with this value already exists",
          ),
        };
      }
      if (code === "23503") {
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: tr(
            "errors.http.referencedRecord",
            "Referenced record does not exist or cannot be removed",
          ),
        };
      }
    }
    this.logger.error(
      "Bulk create row failed",
      error instanceof Error ? error.stack : String(error),
    );
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: tr("errors.http.internal", "Internal server error"),
    };
  }
}
