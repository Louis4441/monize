import { readFileSync } from "fs";
import { join } from "path";
import { describeSkippedRows } from "./bulk-create.types";

/**
 * The tool layers hand a model the reason a batch produced nothing. They used
 * not to: every path computed a per-row reason and answered with a generic
 * guess instead, and on the failure that motivated this the guess was wrong in
 * the way that matters -- seventeen rows were refused because a split
 * transaction's categories live on its split lines and the edit resent none,
 * and the model was told to "check each transactionId". The ids were correct.
 * It concluded the task could not be done and stopped.
 *
 * A model cannot fix a call it has not been told the fault in, so the scan
 * below fails for any "None of ... could be prepared" message that does not
 * carry its reasons.
 */
const TOOL_SOURCES = [
  "ai/query/tool-executor.service.ts",
  "mcp/tools/transactions.tool.ts",
  "mcp/tools/payees.tool.ts",
  "mcp/tools/investments.tool.ts",
];

describe("describeSkippedRows", () => {
  it("says nothing when nothing was skipped", () => {
    expect(describeSkippedRows([])).toBe("");
  });

  it("names the row for a single failure", () => {
    expect(
      describeSkippedRows([{ index: 0, reason: "Unknown account: Nope." }]),
    ).toBe(" Row 1: Unknown account: Nope.");
  });

  it("collapses one shared reason into a count", () => {
    // The common shape: a batch fails the same way in every row, and 17 copies
    // of the same sentence would crowd out the answer.
    const reason =
      "This is a split transaction: its categories live on its split lines.";
    const skipped = Array.from({ length: 17 }, (_, index) => ({
      index,
      reason,
    }));

    const text = describeSkippedRows(skipped, 17);

    expect(text).toBe(` All 17 rows failed the same way: ${reason}`);
    expect(text.match(/split lines/g)).toHaveLength(1);
  });

  it("lists distinct reasons against 1-based row numbers", () => {
    const text = describeSkippedRows([
      { index: 0, reason: "Unknown account." },
      { index: 2, reason: "No fields to update." },
    ]);

    expect(text).toBe(" Row 1: Unknown account. Row 3: No fields to update.");
  });

  it("caps a flood of distinct reasons and counts the rest", () => {
    const text = describeSkippedRows(
      Array.from({ length: 6 }, (_, index) => ({
        index,
        reason: `Reason ${index}.`,
      })),
    );

    expect(text).toContain("Row 1: Reason 0.");
    expect(text).toContain("Row 3: Reason 2.");
    expect(text).not.toContain("Reason 3.");
    expect(text).toContain("(+3 other reasons)");
  });

  it("uses the singular for one unreported reason", () => {
    const text = describeSkippedRows(
      Array.from({ length: 4 }, (_, index) => ({
        index,
        reason: `Reason ${index}.`,
      })),
    );

    expect(text).toContain("(+1 other reason)");
  });

  it("reports the batch size the caller passed, not the skip count", () => {
    // "All 17 rows" is about the request; a caller with partial skips passes
    // its own total so the sentence is not quietly wrong.
    expect(
      describeSkippedRows(
        [
          { index: 0, reason: "Same." },
          { index: 1, reason: "Same." },
        ],
        17,
      ),
    ).toContain("All 17 rows");
  });
});

describe("every all-rows-failed tool error carries its reasons", () => {
  it.each(TOOL_SOURCES)("%s", (relative) => {
    const source = readFileSync(join(__dirname, "..", relative), "utf8");
    // Each message plus the ~200 characters after it: enough to see whether
    // the reasons were appended to the same template literal.
    const messages = [...source.matchAll(/None of [^`"]*could be prepared/g)];
    expect(messages.length).toBeGreaterThan(0);

    const bare = messages
      .map((match) => ({
        text: match[0],
        tail: source.slice(match.index ?? 0, (match.index ?? 0) + 220),
        line: source.slice(0, match.index).split("\n").length,
      }))
      .filter((m) => !m.tail.includes("describeSkippedRows"))
      .map((m) => `${relative}:${m.line} "${m.text}"`);

    expect(bare).toEqual([]);
  });
});
