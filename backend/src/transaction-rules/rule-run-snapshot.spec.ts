import { RuleEffects } from "./rule-effects";
import { CandidateUnit } from "./rule-run-candidates";
import { buildRunSnapshots } from "./rule-run-snapshot";
import { Transaction } from "../transactions/entities/transaction.entity";

const leg = (id: string, over: Partial<Transaction> = {}): Transaction =>
  ({
    id,
    categoryId: null,
    payeeId: null,
    payeeName: "raw",
    description: "old",
    ...over,
  }) as Transaction;

const unit = (...legs: Transaction[]): CandidateUnit => ({
  primary: legs[0],
  legs,
  isTransfer: legs.length > 1,
  fromAccountId: null,
  toAccountId: null,
  crossOwnerTransferLeg: false,
});

const effects = (changes: Partial<RuleEffects["changes"]>): RuleEffects => ({
  changes: { addTagIds: [], removeTagIds: [], ...changes },
  trace: [],
  aiReviewRequests: [],
});

describe("buildRunSnapshots", () => {
  it("records the description before and after, only when a rule changed it", () => {
    const { before, after } = buildRunSnapshots(
      [
        { unit: unit(leg("a")), effects: effects({ description: "new" }) },
        { unit: unit(leg("b")), effects: effects({ categoryId: "c" }) },
      ],
      new Map(),
      {},
    );
    expect(before).toEqual([
      { id: "a", description: "old" },
      { id: "b", categoryId: null },
    ]);
    expect(after).toEqual([
      { id: "a", description: "new" },
      { id: "b", categoryId: "c" },
    ]);
  });

  it("takes a payee's name from the plan when set_payee_from_text chose it, else from the labels", () => {
    const { after } = buildRunSnapshots(
      [
        {
          unit: unit(leg("a")),
          effects: effects({ payeeId: "p1", payeeName: "From text" }),
        },
        { unit: unit(leg("b")), effects: effects({ payeeId: "p2" }) },
      ],
      new Map(),
      { p1: "Label one", p2: "Label two" },
    );
    expect(after).toEqual([
      { id: "a", payeeId: "p1", payeeName: "From text" },
      { id: "b", payeeId: "p2", payeeName: "Label two" },
    ]);
  });

  it("writes one entry per leg of a same-owner transfer", () => {
    const { before, after } = buildRunSnapshots(
      [
        {
          unit: unit(leg("out"), leg("in")),
          effects: effects({ description: "new" }),
        },
      ],
      new Map(),
      {},
    );
    expect(before.map((r) => r.id)).toEqual(["out", "in"]);
    expect(after.map((r) => r.description)).toEqual(["new", "new"]);
  });
});
