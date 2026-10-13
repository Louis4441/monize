import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { Category } from "../categories/entities/category.entity";
import { tr } from "../i18n/translate";

/**
 * Refuse an interest category the caller does not own. Runs inside the
 * caller's transaction, before anything is written, so a refused create or
 * update leaves no row behind.
 */
export async function assertLoanInterestCategory(
  m: EntityManager,
  userId: string,
  categoryId: string,
): Promise<void> {
  const category = await m.getRepository(Category).findOne({
    where: { id: categoryId, userId },
  });
  if (!category) {
    throw new BadRequestException(
      tr(
        "errors.accounts.invalidInterestCategory",
        "Choose one of your own categories for the interest portion of the payment",
      ),
    );
  }
}
