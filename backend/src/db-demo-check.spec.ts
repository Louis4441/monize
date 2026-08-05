import { Logger } from "@nestjs/common";

const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockEnd = jest.fn();

jest.mock("pg", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    query: mockQuery,
    end: mockEnd,
  })),
}));

const mockExit = jest
  .spyOn(process, "exit")
  .mockImplementation((() => {}) as never);

import { checkDemoUser } from "./db-demo-check";

describe("db-demo-check", () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);
    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("exits 0 when the demo user exists, so the entrypoint skips seeding", async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: "demo-id" }] });

    await checkDemoUser();

    expect(mockQuery).toHaveBeenCalledWith(
      "SELECT id FROM users WHERE email = $1",
      ["demo@monize.com"],
    );
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(logSpy).toHaveBeenCalledWith(
      "Demo user already exists; skipping seed",
    );
    expect(mockEnd).toHaveBeenCalled();
  });

  it("exits 1 when the demo user is absent, so the entrypoint seeds", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await checkDemoUser();

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalledWith(
      "Demo user not found; seeding demo data",
    );
  });

  it("exits 1 and warns when the check itself fails -- seeding is idempotent, an empty demo is not", async () => {
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

    await checkDemoUser();

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/ECONNREFUSED/);
  });

  it("closes the connection even when the query fails", async () => {
    mockQuery.mockRejectedValue(new Error("relation does not exist"));

    await checkDemoUser();

    expect(mockEnd).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
