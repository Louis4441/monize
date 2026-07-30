import { EntityManager } from "typeorm";
import { Account } from "../../../accounts/entities/account.entity";
import { MappedLoanTerms } from "../model/mny-import-model";

/**
 * Applies the loan terms the mapper inferred, without overwriting anything the
 * account already carries.
 *
 * Two rules make this safe to run on a second import into a populated profile.
 * A null field on the mapped terms means "the evidence did not settle this",
 * so it is not written at all; and a field the account already has a value for
 * is left alone, because a user who set their loan's interest category by hand
 * outranks an inference from payment shape.
 *
 * Runs after transactions and categories exist, since the terms reference both.
 */

export interface WriteLoansInput {
  readonly loans: readonly MappedLoanTerms[];
  readonly accountIdByKey: ReadonlyMap<string, string>;
  readonly categoryIdByHandle: ReadonlyMap<number, string>;
}

export interface WrittenLoans {
  /** Loan accounts that received at least one inferred term. */
  readonly updated: number;
}

export async function writeLoans(
  manager: EntityManager,
  userId: string,
  input: WriteLoansInput,
): Promise<WrittenLoans> {
  if (input.loans.length === 0) {
    return { updated: 0 };
  }

  const repo = manager.getRepository(Account);
  let updated = 0;

  for (const loan of input.loans) {
    const id = input.accountIdByKey.get(loan.accountKey);
    if (!id) {
      continue;
    }

    const account = await repo.findOne({
      where: { id, userId },
      select: [
        "id",
        "interestCategoryId",
        "interestBookingMode",
        "sourceAccountId",
        "paymentAmount",
        "paymentFrequency",
        "paymentStartDate",
      ],
    });
    if (!account) {
      continue;
    }

    const patch: Partial<Account> = {};

    const interestCategoryId =
      loan.interestCategoryHandle === null
        ? undefined
        : input.categoryIdByHandle.get(loan.interestCategoryHandle);
    if (interestCategoryId && !account.interestCategoryId) {
      patch.interestCategoryId = interestCategoryId;
    }

    // AUTO is the column's default, so an account still on it has never been
    // configured and the inference is an improvement rather than an override.
    if (
      loan.interestBookingMode !== null &&
      account.interestBookingMode === "AUTO"
    ) {
      patch.interestBookingMode = loan.interestBookingMode;
    }

    const sourceAccountId =
      loan.sourceAccountKey === null
        ? undefined
        : input.accountIdByKey.get(loan.sourceAccountKey);
    if (sourceAccountId && !account.sourceAccountId) {
      patch.sourceAccountId = sourceAccountId;
    }

    if (loan.paymentAmount !== null && account.paymentAmount === null) {
      patch.paymentAmount = loan.paymentAmount;
    }
    if (loan.paymentFrequency !== null && account.paymentFrequency === null) {
      patch.paymentFrequency = loan.paymentFrequency;
    }
    if (loan.paymentStartDate !== null && account.paymentStartDate === null) {
      patch.paymentStartDate = loan.paymentStartDate as unknown as Date;
    }

    if (Object.keys(patch).length === 0) {
      continue;
    }

    await repo.update({ id, userId }, patch);
    updated += 1;
  }

  return { updated };
}
