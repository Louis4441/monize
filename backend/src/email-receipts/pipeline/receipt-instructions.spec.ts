import { readFileSync } from "fs";
import { join } from "path";
import {
  RECEIPT_AUTOMATIC_AI_INSTRUCTION,
  RECEIPT_CATEGORIZE_INSTRUCTION,
  RECEIPT_CHAT_INSTRUCTION,
  RECEIPT_PARSED_INSTRUCTION,
  receiptInstructionKey,
} from "./receipt-instructions";

describe("receiptInstructionKey", () => {
  it("names each fixed instruction the pipeline writes", () => {
    expect(receiptInstructionKey(RECEIPT_AUTOMATIC_AI_INSTRUCTION)).toBe(
      "automatic",
    );
    expect(receiptInstructionKey(RECEIPT_CHAT_INSTRUCTION)).toBe("chat");
    expect(receiptInstructionKey(RECEIPT_CATEGORIZE_INSTRUCTION)).toBe(
      "categorize",
    );
    expect(receiptInstructionKey(RECEIPT_PARSED_INSTRUCTION)).toBe("parsed");
  });

  it("is null for any other text, a rule's own words included", () => {
    expect(receiptInstructionKey("Split it by product")).toBeNull();
    expect(receiptInstructionKey(`${RECEIPT_PARSED_INSTRUCTION} `)).toBeNull();
  });
});

describe("where the fixed instructions are imported from", () => {
  it("is the leaf file only: the pipeline service does not re-export them", () => {
    const src = readFileSync(
      join(__dirname, "email-receipt-pipeline.service.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/export\s*\{[^}]*RECEIPT_\w+_INSTRUCTION/);
  });
});
