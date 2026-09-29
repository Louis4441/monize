import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { lockTransactionRows } from "../common/db/locks";
import { Transaction } from "../transactions/entities/transaction.entity";
import { assertReconciledRowsMutable } from "../transactions/reconciled-lock.util";
import { ActionHistory } from "./entities/action-history.entity";
import { undoRuleRun } from "./rule-run-undo";

jest.mock("../common/db/locks", () => ({ lockTransactionRows: jest.fn() }));
jest.mock("../transactions/reconciled-lock.util", () => ({
  assertReconciledRowsMutable: jest.fn(),
}));

const USER = "user-1";

function action(transactions: unknown): ActionHistory {
  return {
    id: "a1",
    userId: USER,
    entityType: "transaction_rule_run",
    action: "bulk_update",
    beforeData: transactions === undefined ? null : { transactions },
  } as unknown as ActionHistory;
}

function harness() {
  const manager = {
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    query: jest.fn().mockResolvedValue([]),
  };
  return { manager, em: manager as unknown as EntityManager };
}

const locked = (...ids: string[]) =>
  new Map(ids.map((id) => [id, { id, status: "UNRECONCILED" }]));

describe("undoRuleRun", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("does nothing for an entry without rows", async () => {
    const { manager, em } = harness();
    await undoRuleRun(action(undefined), em);
    await undoRuleRun(action([]), em);
    expect(lockTransactionRows).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });

  it("restores only the fields the snapshot holds, scoped to the user", async () => {
    const { manager, em } = harness();
    (lockTransactionRows as jest.Mock).mockResolvedValue(locked("t1", "t2"));

    await undoRuleRun(
      action([
        { id: "t1", categoryId: null },
        {
          id: "t2",
          payeeId: "p-old",
          payeeName: "Old",
          categoryId: "c-old",
        },
      ]),
      em,
    );

    expect(manager.update).toHaveBeenCalledTimes(2);
    expect(manager.update).toHaveBeenCalledWith(
      Transaction,
      { id: "t1", userId: USER },
      { categoryId: null },
    );
    expect(manager.update).toHaveBeenCalledWith(
      Transaction,
      { id: "t2", userId: USER },
      { categoryId: "c-old", payeeId: "p-old", payeeName: "Old" },
    );
    // No tag snapshot: no tag statement.
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("restores the description, alone or with the payee, and a null description", async () => {
    const { manager, em } = harness();
    (lockTransactionRows as jest.Mock).mockResolvedValue(locked("t1", "t2"));
    await undoRuleRun(
      action([
        { id: "t1", description: "before" },
        {
          id: "t2",
          payeeId: null,
          payeeName: "raw",
          description: null,
        },
      ]),
      em,
    );
    expect(manager.update).toHaveBeenCalledWith(
      Transaction,
      { id: "t1", userId: USER },
      { description: "before" },
    );
    expect(manager.update).toHaveBeenCalledWith(
      Transaction,
      { id: "t2", userId: USER },
      { payeeId: null, payeeName: "raw", description: null },
    );
  });

  it("restores a null payee and null name", async () => {
    const { manager, em } = harness();
    (lockTransactionRows as jest.Mock).mockResolvedValue(locked("t1"));
    await undoRuleRun(
      action([{ id: "t1", payeeId: null, payeeName: null }]),
      em,
    );
    expect(manager.update).toHaveBeenCalledWith(
      Transaction,
      { id: "t1", userId: USER },
      { payeeId: null, payeeName: null },
    );
  });

  it("replaces the tag set of every row that recorded one in two statements", async () => {
    const { manager, em } = harness();
    (lockTransactionRows as jest.Mock).mockResolvedValue(
      locked("t1", "t2", "t3"),
    );

    await undoRuleRun(
      action([
        { id: "t1", tagIds: ["g1", "g2"] },
        { id: "t2", tagIds: [] },
        { id: "t3", categoryId: "c" },
      ]),
      em,
    );

    expect(manager.query).toHaveBeenCalledTimes(2);
    const [deleteSql, deleteArgs] = manager.query.mock.calls[0];
    expect(deleteSql).toContain("DELETE FROM transaction_tags");
    expect(deleteSql).toContain("t.user_id = $1");
    expect(deleteArgs).toEqual([USER, ["t1", "t2"]]);
    const [insertSql, insertArgs] = manager.query.mock.calls[1];
    expect(insertSql).toContain("INSERT INTO transaction_tags");
    expect(insertSql).toContain("g.user_id = $1");
    expect(insertArgs).toEqual([USER, ["t1", "t1"], ["g1", "g2"]]);
  });

  it("deletes the tags but inserts nothing when the snapshot set was empty", async () => {
    const { manager, em } = harness();
    (lockTransactionRows as jest.Mock).mockResolvedValue(locked("t1"));
    await undoRuleRun(action([{ id: "t1", tagIds: [] }]), em);
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(manager.query.mock.calls[0][0]).toContain("DELETE");
  });

  it("skips a row deleted since the run", async () => {
    const { manager, em } = harness();
    (lockTransactionRows as jest.Mock).mockResolvedValue(locked("t1"));
    await undoRuleRun(
      action([
        { id: "gone", categoryId: null, tagIds: ["g1"] },
        { id: "t1", categoryId: "c" },
      ]),
      em,
    );
    expect(manager.update).toHaveBeenCalledTimes(1);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("locks the rows in one call and refuses on the reconciled lock before any write", async () => {
    const { manager, em } = harness();
    (lockTransactionRows as jest.Mock).mockResolvedValue(locked("t1"));
    (assertReconciledRowsMutable as jest.Mock).mockRejectedValue(
      new ConflictException("locked"),
    );

    await expect(
      undoRuleRun(action([{ id: "t1", categoryId: null, tagIds: [] }]), em),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(lockTransactionRows).toHaveBeenCalledWith(em, ["t1"], USER);
    expect(assertReconciledRowsMutable).toHaveBeenCalledWith(em, USER, [
      { id: "t1", status: "UNRECONCILED" },
    ]);
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalled();
  });
});
