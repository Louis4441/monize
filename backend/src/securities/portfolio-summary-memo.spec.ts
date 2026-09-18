import {
  buildPortfolioSummaryMemoKey,
  invalidateAllPortfolioSummaries,
  invalidatePortfolioSummary,
  PORTFOLIO_SUMMARY_MEMO_MAX_ENTRIES,
  PORTFOLIO_SUMMARY_MEMO_TTL_MS,
  portfolioSummaryMemo,
} from "./portfolio-summary-memo";
import { withSystemContext, withUserContext } from "../common/db/with-context";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("portfolio summary memo", () => {
  beforeEach(() => {
    portfolioSummaryMemo.clearAll();
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    portfolioSummaryMemo.clearAll();
  });

  describe("buildPortfolioSummaryMemoKey", () => {
    it("normalises the account scope so order does not split the key", () => {
      expect(buildPortfolioSummaryMemoKey("u1", ["b", "a"], "CAD")).toBe(
        buildPortfolioSummaryMemoKey("u1", ["a", "b"], "CAD"),
      );
    });

    it("separates the whole portfolio from an explicit scope", () => {
      expect(buildPortfolioSummaryMemoKey("u1", undefined, "CAD")).not.toBe(
        buildPortfolioSummaryMemoKey("u1", ["a"], "CAD"),
      );
      expect(buildPortfolioSummaryMemoKey("u1", [], "CAD")).toBe(
        buildPortfolioSummaryMemoKey("u1", undefined, "CAD"),
      );
    });

    it("separates reporting currencies", () => {
      expect(buildPortfolioSummaryMemoKey("u1", undefined, "CAD")).not.toBe(
        buildPortfolioSummaryMemoKey("u1", undefined, "USD"),
      );
    });

    it("separates the ambient identity, so a delegate never reads an owner's entry", () => {
      const asOwner = withUserContext(UUID_A, () =>
        buildPortfolioSummaryMemoKey(UUID_A, ["acct-1"], "CAD"),
      );
      const asDelegate = withSystemContext(() =>
        // A delegate request enters the same effective user with a different
        // real user; `withSystemContext` stands in for "a different ambient
        // identity" without needing the delegation stack here.
        buildPortfolioSummaryMemoKey(UUID_A, ["acct-1"], "CAD"),
      );
      expect(asOwner).not.toBe(asDelegate);
    });
  });

  describe("run", () => {
    it("computes once for callers that arrive while the first is in flight", async () => {
      const compute = jest.fn(
        () =>
          new Promise<string>((resolve) => setTimeout(() => resolve("v"), 5)),
      );

      const [a, b, c] = await Promise.all([
        portfolioSummaryMemo.run("u1", "k", compute),
        portfolioSummaryMemo.run("u1", "k", compute),
        portfolioSummaryMemo.run("u1", "k", compute),
      ]);

      expect(compute).toHaveBeenCalledTimes(1);
      expect([a, b, c]).toEqual(["v", "v", "v"]);
    });

    it("serves the settled value again inside the TTL and recomputes after it", async () => {
      jest.useFakeTimers();
      const compute = jest
        .fn<Promise<number>, []>()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2);

      await expect(portfolioSummaryMemo.run("u1", "k", compute)).resolves.toBe(
        1,
      );
      jest.advanceTimersByTime(PORTFOLIO_SUMMARY_MEMO_TTL_MS - 1);
      await expect(portfolioSummaryMemo.run("u1", "k", compute)).resolves.toBe(
        1,
      );
      jest.advanceTimersByTime(2);
      await expect(portfolioSummaryMemo.run("u1", "k", compute)).resolves.toBe(
        2,
      );
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it("does not remember a failure", async () => {
      const compute = jest
        .fn<Promise<string>, []>()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce("v");

      await expect(
        portfolioSummaryMemo.run("u1", "k", compute),
      ).rejects.toThrow("boom");
      await expect(portfolioSummaryMemo.run("u1", "k", compute)).resolves.toBe(
        "v",
      );
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it("keeps the memo bounded, evicting the oldest key first", async () => {
      for (let i = 0; i < PORTFOLIO_SUMMARY_MEMO_MAX_ENTRIES + 10; i++) {
        await portfolioSummaryMemo.run("u1", `k${i}`, async () => i);
      }
      expect(portfolioSummaryMemo.size).toBe(
        PORTFOLIO_SUMMARY_MEMO_MAX_ENTRIES,
      );
      // The first key was evicted, so it recomputes.
      const compute = jest.fn(async () => -1);
      await portfolioSummaryMemo.run("u1", "k0", compute);
      expect(compute).toHaveBeenCalledTimes(1);
    });
  });

  describe("invalidation", () => {
    it("drops one user's entries and leaves another's", async () => {
      const a = jest.fn(async () => "a");
      const b = jest.fn(async () => "b");
      await portfolioSummaryMemo.run(UUID_A, "ka", a);
      await portfolioSummaryMemo.run(UUID_B, "kb", b);

      invalidatePortfolioSummary(UUID_A);

      await portfolioSummaryMemo.run(UUID_A, "ka", a);
      await portfolioSummaryMemo.run(UUID_B, "kb", b);
      expect(a).toHaveBeenCalledTimes(2);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it("drops every user's entries on a whole-dataset write", async () => {
      const a = jest.fn(async () => "a");
      const b = jest.fn(async () => "b");
      await portfolioSummaryMemo.run(UUID_A, "ka", a);
      await portfolioSummaryMemo.run(UUID_B, "kb", b);

      invalidateAllPortfolioSummaries();

      await portfolioSummaryMemo.run(UUID_A, "ka", a);
      await portfolioSummaryMemo.run(UUID_B, "kb", b);
      expect(a).toHaveBeenCalledTimes(2);
      expect(b).toHaveBeenCalledTimes(2);
    });
  });
});
