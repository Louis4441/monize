import "reflect-metadata";
import { validate, ValidationError } from "class-validator";
import { plainToInstance } from "class-transformer";
import { BulkUpdateDto } from "./bulk-update.dto";

function buildDto(data: any): BulkUpdateDto {
  return plainToInstance(BulkUpdateDto, data, {
    enableImplicitConversion: true,
  });
}

/** Constraint names anywhere in the (nested) error tree. */
function constraintNames(errors: ValidationError[]): string[] {
  return errors.flatMap((e) => [
    ...Object.keys(e.constraints ?? {}),
    ...constraintNames(e.children ?? []),
  ]);
}

const uuid = "d290f1ee-6c54-4b01-90e6-d701748f0851";

describe("BulkUpdateDto filter fields", () => {
  it("accepts amountFrom, amountTo and tagIds", async () => {
    const dto = buildDto({
      mode: "filter",
      filters: {
        // amountTo 0 on purpose: a defined-but-falsy bound is still a bound.
        amountFrom: -250.75,
        amountTo: 0,
        tagIds: [uuid],
      },
      description: "x",
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it("rejects more than 100 tagIds", async () => {
    const dto = buildDto({
      mode: "filter",
      filters: {
        tagIds: Array.from({ length: 101 }, () => uuid),
      },
      description: "x",
    });

    const errors = await validate(dto);

    expect(constraintNames(errors)).toContain("arrayMaxSize");
  });

  it("accepts exactly 100 tagIds", async () => {
    const dto = buildDto({
      mode: "filter",
      filters: {
        tagIds: Array.from({ length: 100 }, () => uuid),
      },
      description: "x",
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it("rejects a non-UUID tagId", async () => {
    const dto = buildDto({
      mode: "filter",
      filters: { tagIds: ["not-a-uuid"] },
      description: "x",
    });

    const errors = await validate(dto);

    expect(constraintNames(errors)).toContain("isUuid");
  });

  it("rejects a non-numeric amountFrom", async () => {
    const dto = buildDto({
      mode: "filter",
      filters: { amountFrom: "lots" },
      description: "x",
    });

    const errors = await validate(dto);

    expect(constraintNames(errors)).toContain("isNumber");
  });
});

describe("BulkUpdateDto categoryFilterIds", () => {
  it("accepts categoryFilterIds in ids mode, pseudo-ids included", async () => {
    // The active category filter rides along in BOTH selection modes; the
    // pseudo-ids are legal here and stripped server-side.
    const dto = buildDto({
      mode: "ids",
      transactionIds: [uuid],
      categoryFilterIds: [uuid, "uncategorized", "transfer"],
      categoryId: uuid,
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it("rejects more than 100 categoryFilterIds", async () => {
    const dto = buildDto({
      mode: "ids",
      transactionIds: [uuid],
      categoryFilterIds: Array.from({ length: 101 }, () => uuid),
      categoryId: uuid,
    });

    const errors = await validate(dto);

    expect(constraintNames(errors)).toContain("arrayMaxSize");
  });
});
