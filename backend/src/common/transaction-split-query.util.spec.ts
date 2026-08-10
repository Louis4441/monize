import { readFileSync } from "fs";
import { join } from "path";
import {
  SPLIT_AMOUNT,
  SPLIT_CATEGORY_ID,
  joinSplitsForAnalytics,
} from "./transaction-split-query.util";

describe("transaction-split-query SQL fragments", () => {
  it("exposes COALESCE expressions for category id and amount", () => {
    expect(SPLIT_CATEGORY_ID).toBe("COALESCE(ts.categoryId, t.categoryId)");
    expect(SPLIT_AMOUNT).toBe("COALESCE(ts.amount, t.amount)");
  });

  it("offers no category-name fragment to group or label by", () => {
    // A leaf name is not an identity: two categories named "Cell Phone" under
    // different parents merged into one analytics row, and the row's label
    // named whichever parent the reader guessed. The fix is to group on the id
    // and qualify the label, so the fragment that made the mistake easy is gone
    // -- and stays gone.
    const source = readFileSync(
      join(__dirname, "transaction-split-query.util.ts"),
      "utf8",
    );
    // Comments stripped: the docblock names the mistake in order to explain it,
    // and a scan that cannot tell prose from code would forbid saying so.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const exportedNames = [...code.matchAll(/export const (\w+)/g)].map(
      (m) => m[1],
    );
    expect(exportedNames).not.toContain("SPLIT_CATEGORY_NAME");
    expect(code).not.toMatch(/splitCat\.name/);
  });
});

describe("joinSplitsForAnalytics", () => {
  it("left joins splits and split category and excludes transfer splits", () => {
    const leftJoin = jest.fn().mockReturnThis();
    const andWhere = jest.fn().mockReturnThis();
    const qb = { leftJoin, andWhere } as any;

    const result = joinSplitsForAnalytics(qb);

    expect(result).toBe(qb);
    expect(leftJoin).toHaveBeenCalledWith("t.splits", "ts");
    expect(leftJoin).toHaveBeenCalledWith("ts.category", "splitCat");
    expect(andWhere).toHaveBeenCalledWith(
      "(ts.transferAccountId IS NULL OR ts.id IS NULL)",
    );
  });
});
