import { ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { ActionHistoryService } from "./action-history.service";
import { ActionHistory } from "./entities/action-history.entity";
import { RULE_RUN_ENTITY_TYPE, undoRuleRun } from "./rule-run-undo";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("./rule-run-undo", () => ({
  RULE_RUN_ENTITY_TYPE: "transaction_rule_run",
  undoRuleRun: jest.fn(),
}));

/** A manual rule run is one entry; undo and redo route it to `undoRuleRun`. */
describe("ActionHistoryService: transaction rule run entries", () => {
  const userId = "user-1";
  let service: ActionHistoryService;
  let repo: Record<string, jest.Mock>;
  let manager: Record<string, jest.Mock>;

  const entry = {
    id: "h1",
    userId,
    entityType: RULE_RUN_ENTITY_TYPE,
    entityId: "rule-1",
    action: "bulk_update",
    beforeData: { transactions: [{ id: "t1", categoryId: null }] },
    afterData: { transactions: [{ id: "t1", categoryId: "c1" }] },
    isUndone: false,
    description: 'Ran rule "R" on 1 transaction',
  } as unknown as ActionHistory;

  beforeEach(async () => {
    jest.clearAllMocks();
    repo = { findOne: jest.fn() };
    const scoped = createScopedDbMocks([[ActionHistory, repo]]);
    manager = scoped.manager;
    manager.update.mockResolvedValue({ affected: 1 });
    const module = await Test.createTestingModule({
      providers: [
        ActionHistoryService,
        { provide: DataSource, useValue: scoped.dataSource },
      ],
    }).compile();
    service = module.get(ActionHistoryService);
  });

  it("undo hands the entry, as recorded, to undoRuleRun and marks it undone", async () => {
    repo.findOne.mockResolvedValue(entry);

    const result = await service.undo(userId);

    expect(undoRuleRun).toHaveBeenCalledTimes(1);
    expect(undoRuleRun).toHaveBeenCalledWith(entry, manager);
    expect(result.description).toContain("Undone");
    expect(manager.update).toHaveBeenCalledWith(ActionHistory, "h1", {
      isUndone: true,
    });
  });

  it("redo replays the after side: before and after are swapped", async () => {
    repo.findOne.mockResolvedValue({ ...entry, isUndone: true });

    await service.redo(userId);

    const replayed = (undoRuleRun as jest.Mock).mock.calls[0][0];
    expect(replayed.beforeData).toEqual(entry.afterData);
    expect(replayed.action).toBe("bulk_update");
    expect(manager.update).toHaveBeenCalledWith(ActionHistory, "h1", {
      isUndone: false,
    });
  });

  it("a refusal from the undo leaves the entry as it was", async () => {
    repo.findOne.mockResolvedValue(entry);
    (undoRuleRun as jest.Mock).mockRejectedValue(
      new ConflictException("locked"),
    );

    await expect(service.undo(userId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(manager.update).not.toHaveBeenCalled();
  });
});
