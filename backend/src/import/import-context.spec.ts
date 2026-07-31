import { updateAccountBalance } from "./import-context";
import { Account } from "../accounts/entities/account.entity";

describe("updateAccountBalance", () => {
  const makeMockManager = (account: any = null) =>
    ({
      findOne: jest.fn().mockResolvedValue(account),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    }) as any;

  it("should add positive amount to account balance", async () => {
    const manager = makeMockManager({
      id: "acc-1",
      currentBalance: 100,
    });

    await updateAccountBalance(manager, "acc-1", 50);

    expect(manager.findOne).toHaveBeenCalledWith(Account, {
      where: { id: "acc-1" },
    });
    expect(manager.update).toHaveBeenCalledWith(Account, "acc-1", {
      currentBalance: 150,
    });
  });

  it("should subtract negative amount from account balance", async () => {
    const manager = makeMockManager({
      id: "acc-1",
      currentBalance: 200,
    });

    await updateAccountBalance(manager, "acc-1", -75);

    expect(manager.update).toHaveBeenCalledWith(Account, "acc-1", {
      currentBalance: 125,
    });
  });

  it("should handle zero balance correctly", async () => {
    const manager = makeMockManager({
      id: "acc-1",
      currentBalance: 0,
    });

    await updateAccountBalance(manager, "acc-1", 100);

    expect(manager.update).toHaveBeenCalledWith(Account, "acc-1", {
      currentBalance: 100,
    });
  });

  it("should handle zero amount correctly (no change)", async () => {
    const manager = makeMockManager({
      id: "acc-1",
      currentBalance: 500,
    });

    await updateAccountBalance(manager, "acc-1", 0);

    expect(manager.update).toHaveBeenCalledWith(Account, "acc-1", {
      currentBalance: 500,
    });
  });

  it("should round to 2 decimal places", async () => {
    const manager = makeMockManager({
      id: "acc-1",
      currentBalance: 10.1,
    });

    await updateAccountBalance(manager, "acc-1", 20.2);

    expect(manager.update).toHaveBeenCalledWith(Account, "acc-1", {
      currentBalance: 30.3,
    });
  });

  it("should handle floating point precision issues", async () => {
    // 0.1 + 0.2 = 0.30000000000000004 in JavaScript
    const manager = makeMockManager({
      id: "acc-1",
      currentBalance: 0.1,
    });

    await updateAccountBalance(manager, "acc-1", 0.2);

    expect(manager.update).toHaveBeenCalledWith(Account, "acc-1", {
      currentBalance: 0.3,
    });
  });

  it("should handle string currentBalance from database (decimal column)", async () => {
    const manager = makeMockManager({
      id: "acc-1",
      currentBalance: "150.50",
    });

    await updateAccountBalance(manager, "acc-1", 25.25);

    expect(manager.update).toHaveBeenCalledWith(Account, "acc-1", {
      currentBalance: 175.75,
    });
  });

  it("should handle null currentBalance as zero", async () => {
    const manager = makeMockManager({
      id: "acc-1",
      currentBalance: null,
    });

    await updateAccountBalance(manager, "acc-1", 100);

    expect(manager.update).toHaveBeenCalledWith(Account, "acc-1", {
      currentBalance: 100,
    });
  });

  it("should handle undefined currentBalance as zero", async () => {
    const manager = makeMockManager({
      id: "acc-1",
      currentBalance: undefined,
    });

    await updateAccountBalance(manager, "acc-1", 50);

    expect(manager.update).toHaveBeenCalledWith(Account, "acc-1", {
      currentBalance: 50,
    });
  });

  it("should not update balance if account is not found", async () => {
    const manager = makeMockManager(null);

    await updateAccountBalance(manager, "non-existent", 100);

    expect(manager.findOne).toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });

  it("should handle negative balance correctly", async () => {
    const manager = makeMockManager({
      id: "acc-1",
      currentBalance: -500,
    });

    await updateAccountBalance(manager, "acc-1", 200);

    expect(manager.update).toHaveBeenCalledWith(Account, "acc-1", {
      currentBalance: -300,
    });
  });

  it("should handle large amounts correctly", async () => {
    const manager = makeMockManager({
      id: "acc-1",
      currentBalance: 999999.99,
    });

    await updateAccountBalance(manager, "acc-1", 0.01);

    expect(manager.update).toHaveBeenCalledWith(Account, "acc-1", {
      currentBalance: 1000000,
    });
  });

  it("should use the correct accountId for both findOne and update", async () => {
    const manager = makeMockManager({
      id: "specific-acc",
      currentBalance: 100,
    });

    await updateAccountBalance(manager, "specific-acc", 50);

    expect(manager.findOne).toHaveBeenCalledWith(
      Account,
      expect.objectContaining({
        where: { id: "specific-acc" },
      }),
    );
    expect(manager.update).toHaveBeenCalledWith(
      Account,
      "specific-acc",
      expect.anything(),
    );
  });

  it("should handle string amount from QIF parsing", async () => {
    const manager = makeMockManager({
      id: "acc-1",
      currentBalance: 100,
    });

    // Amount might come as a number, but the function casts with Number()
    await updateAccountBalance(manager, "acc-1", 25.5);

    expect(manager.update).toHaveBeenCalledWith(Account, "acc-1", {
      currentBalance: 125.5,
    });
  });
});
