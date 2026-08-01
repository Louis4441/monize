import { NotFoundException } from "@nestjs/common";
import { Account } from "../accounts/entities/account.entity";
import { Security } from "../securities/entities/security.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { GemStrategy } from "./entities/gem-strategy.entity";
import { GemStrategyAccount } from "./entities/gem-strategy-account.entity";
import { GemStrategyAsset } from "./entities/gem-strategy-asset.entity";
import { GemStrategySignal } from "./entities/gem-strategy-signal.entity";
import { GemStrategyService } from "./gem-strategy.service";
import {
  createScopedDbMocks,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// The report's calendar and staleness checks read "today"; pin it so the
// expectations are about the rules, not about the day the suite runs.
jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: () => "2025-08-14",
}));

const userId = "user-1";

const storedStrategy = (overrides: Partial<GemStrategy> = {}): GemStrategy =>
  ({
    id: "strategy-1",
    userId,
    name: "GEM",
    cadence: "MONTHLY",
    lookbackMonths: 12,
    taxRatePercent: 19,
    commissionAmount: 29.9,
    rulesSourceUrl: "https://example.test/gem",
    rulesSourceLabel: "example.test/gem",
    ...overrides,
  }) as GemStrategy;

const storedAssets = (): GemStrategyAsset[] =>
  [
    {
      role: "US_EQUITY",
      securityId: "sec-spy",
      security: { symbol: "SPY", name: "S&P 500 ETF" },
    },
    {
      role: "EX_US_EQUITY",
      securityId: "sec-ewa",
      security: { symbol: "EWA", name: "World ex-US ETF" },
    },
    {
      role: "EM_EQUITY",
      securityId: "sec-emim",
      security: { symbol: "EMIM", name: "EM IMI ETF" },
    },
    {
      role: "SAFE",
      securityId: "sec-ief",
      security: { symbol: "IEF", name: "Treasuries" },
    },
  ] as GemStrategyAsset[];

const storedSignal = (
  overrides: Partial<GemStrategySignal> = {},
): GemStrategySignal =>
  ({
    id: "sig-1",
    userId,
    strategyId: "strategy-1",
    evaluatedOn: "2025-07-31",
    effectiveFrom: "2025-08-01",
    state: "RISK_ON",
    targetRole: "EM_EQUITY",
    targetSecurityId: "sec-emim",
    targetWeightPercent: 100,
    momentum: {
      US_EQUITY: 15.42,
      EX_US_EQUITY: 8.31,
      EM_EQUITY: 29.87,
      SAFE: 4.21,
    },
    spreadPp: 11.21,
    leadPp: 14.45,
    previousRole: "US_EQUITY",
    executed: false,
    ...overrides,
  }) as GemStrategySignal;

describe("GemStrategyService", () => {
  let service: GemStrategyService;
  let manager: ManagerMock;
  let strategyRepo: Record<string, jest.Mock>;
  let assetRepo: Record<string, jest.Mock>;
  let strategyAccountRepo: Record<string, jest.Mock>;
  let accountRepo: Record<string, jest.Mock>;
  let securityRepo: Record<string, jest.Mock>;
  let preferenceRepo: Record<string, jest.Mock>;
  let signalService: Record<string, jest.Mock>;
  let positionService: { build: jest.Mock };
  let performanceService: { build: jest.Mock };
  let priceService: { latestPriceDates: jest.Mock };
  let backfillService: { ensureHistory: jest.Mock };
  let backtestService: { build: jest.Mock };

  beforeEach(() => {
    strategyRepo = {
      findOne: jest.fn().mockResolvedValue(storedStrategy()),
      find: jest.fn().mockResolvedValue([storedStrategy()]),
      remove: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((row) => ({ ...row })),
      save: jest.fn((row) => Promise.resolve({ id: "strategy-1", ...row })),
    };
    assetRepo = {
      find: jest.fn().mockResolvedValue(storedAssets()),
      create: jest.fn((row) => ({ ...row })),
      save: jest.fn((row) => Promise.resolve(row)),
    };
    strategyAccountRepo = {
      find: jest.fn().mockResolvedValue([
        {
          accountId: "acct-1",
          account: { id: "acct-1", name: "Broker IRA" },
        },
      ]),
      create: jest.fn((row) => ({ ...row })),
      save: jest.fn((rows) => Promise.resolve(rows)),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    accountRepo = {
      findOne: jest.fn().mockResolvedValue({ id: "acct-1" }),
      find: jest.fn().mockResolvedValue([{ id: "acct-1" }]),
    };
    securityRepo = {
      // Doubles for two reads: the ownership check on save, which only looks at
      // ids, and the history's own lookup, which needs the symbol each past
      // decision named.
      find: jest
        .fn()
        .mockResolvedValue([
          { id: "sec-emim", symbol: "EMIM", name: "EM IMI ETF" },
        ]),
    };
    preferenceRepo = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "CAD" }),
    };

    const mocks = createScopedDbMocks([
      [GemStrategy, strategyRepo],
      [GemStrategyAsset, assetRepo],
      [GemStrategyAccount, strategyAccountRepo],
      [Account, accountRepo],
      [Security, securityRepo],
      [UserPreference, preferenceRepo],
    ]);
    manager = mocks.manager;

    signalService = {
      materialize: jest
        .fn()
        .mockResolvedValue({ signals: [storedSignal()], legacyPeriods: 0 }),
      currentSignal: jest.fn().mockReturnValue(storedSignal()),
      markExecuted: jest.fn().mockResolvedValue(true),
      hasSignalsBefore: jest.fn().mockResolvedValue(false),
    };
    positionService = {
      build: jest.fn().mockResolvedValue({
        position: {
          accounts: [{ id: "acct-1", name: "Broker IRA" }],
          current: null,
          target: null,
          compliancePercent: 64,
          changeRequired: true,
          currencyCode: "USD",
        },
        action: { required: true, executed: false },
        noPosition: false,
      }),
    };
    performanceService = {
      build: jest.fn().mockResolvedValue({
        range: "1Y",
        points: [],
        totals: {},
        currencyCode: "USD",
        incomplete: false,
      }),
    };
    priceService = {
      // Every assigned instrument priced on the same recent day, so nothing
      // is stale unless a test says otherwise.
      latestPriceDates: jest
        .fn()
        .mockImplementation((ids: string[]) =>
          Promise.resolve(new Map(ids.map((id) => [id, "2025-08-13"]))),
        ),
    };
    backfillService = { ensureHistory: jest.fn().mockResolvedValue([]) };
    backtestService = { build: jest.fn().mockResolvedValue(null) };

    service = new GemStrategyService(
      mocks.dataSource as never,
      signalService as never,
      positionService as never,
      performanceService as never,
      priceService as never,
      backfillService as never,
      backtestService as never,
    );
  });

  describe("getReport", () => {
    it("assembles the signal, both decision steps and the history", async () => {
      const report = await service.getReport(userId);

      expect(report.strategy).toMatchObject({
        id: "strategy-1",
        cadence: "MONTHLY",
        // The settings form edits these, so the report has to carry them.
        lookbackMonths: 12,
        taxRatePercent: 19,
        commissionAmount: 29.9,
        nextEvaluationOn: "2025-08-31",
        daysUntilNextEvaluation: 17,
        pricesAsOf: "2025-08-13",
        rulesSourceLabel: "example.test/gem",
        accounts: [{ id: "acct-1", name: "Broker IRA" }],
      });

      expect(report.signal).toMatchObject({
        id: "sig-1",
        state: "RISK_ON",
        targetWeightPercent: 100,
        effectiveFrom: "2025-08-01",
      });
      expect(report.signal?.target?.symbol).toBe("EMIM");
      expect(report.signal?.absolute).toMatchObject({
        spreadPp: 11.21,
        result: "RISK_ON",
      });
      expect(report.signal?.absolute.equity).toMatchObject({
        symbol: "SPY",
        momentum12m: 15.42,
        rank: 2,
      });
      expect(report.signal?.absolute.benchmark.momentum12m).toBe(4.21);
      expect(
        report.signal?.relative.ranking.map((entry) => entry.symbol),
      ).toEqual(["EMIM", "SPY", "EWA"]);
      expect(report.signal?.relative).toMatchObject({
        leadPp: 14.45,
        applied: true,
      });

      // Every role, the optional risk-free yardstick included, so the client
      // can render the one this strategy leaves unassigned.
      expect(report.assets).toHaveLength(5);
      expect(report.history).toHaveLength(1);
      expect(report.history[0]).toMatchObject({
        action: "SWITCH",
        executed: false,
      });
      expect(report.history[0].change).toEqual({
        from: expect.objectContaining({ symbol: "SPY" }),
        to: expect.objectContaining({ symbol: "EMIM" }),
      });
    });

    it("resolves what a period switched out of from the entry before it", async () => {
      // With a period missing from the middle of the history -- one the
      // current configuration cannot answer for, so `materialize` leaves it
      // out -- the predecessor is the next entry that is there, and it must be
      // that period's own instrument. Positional adjacency is only sound
      // because every row in this array comes from one configuration.
      signalService.materialize.mockResolvedValue({
        signals: [
          storedSignal({
            id: "sig-jul",
            evaluatedOn: "2025-07-31",
            effectiveFrom: "2025-08-01",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-emim",
            previousRole: "US_EQUITY",
          }),
          storedSignal({
            id: "sig-may",
            evaluatedOn: "2025-05-31",
            effectiveFrom: "2025-06-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-may-spy",
          }),
        ],
        legacyPeriods: 0,
      });
      securityRepo.find.mockResolvedValue([
        { id: "sec-emim", symbol: "EMIM", name: "EM IMI ETF" },
        {
          id: "sec-may-spy",
          symbol: "SPY",
          name: "The fund May actually held",
        },
      ]);

      const report = await service.getReport(userId);

      expect(report.history[0].change).toEqual({
        from: expect.objectContaining({
          securityId: "sec-may-spy",
          name: "The fund May actually held",
        }),
        to: expect.objectContaining({ securityId: "sec-emim" }),
      });
    });

    it("shows the instrument a past decision named, not today's", async () => {
      // History used to resolve every role through the current mapping, so
      // replacing the EM fund rewrote the past: an entry from July claimed to
      // have bought whatever was assigned in August.
      signalService.materialize.mockResolvedValue({
        signals: [storedSignal({ targetSecurityId: "sec-retired" })],
        legacyPeriods: 0,
      });
      securityRepo.find.mockResolvedValue([
        {
          id: "sec-retired",
          symbol: "EEM",
          name: "The fund it actually bought",
        },
      ]);

      const report = await service.getReport(userId);

      expect(report.history[0].winner).toMatchObject({
        securityId: "sec-retired",
        symbol: "EEM",
      });
      // The role's current instrument is still what the settings say.
      expect(
        report.assets.find((asset) => asset.role === "EM_EQUITY")?.symbol,
      ).toBe("EMIM");
    });

    it("falls back to the role's instrument when the stored one is gone", async () => {
      // ON DELETE SET NULL leaves the signal without a security; naming the
      // role's current fund is better than showing an empty row, and the
      // momentum figures beside it are still what was decided on.
      signalService.materialize.mockResolvedValue({
        signals: [storedSignal({ targetSecurityId: null })],
        legacyPeriods: 0,
      });

      const report = await service.getReport(userId);

      expect(report.history[0].winner).toMatchObject({
        role: "EM_EQUITY",
        symbol: "EMIM",
      });
      // A backtest needs a cost model the configuration does not carry yet.
      expect(report.backtest).toBeNull();
      expect(report.warnings).toEqual([]);
    });

    it("marks the equity ranking as not applied while RISK-OFF", async () => {
      signalService.currentSignal.mockReturnValue(
        storedSignal({
          state: "RISK_OFF",
          targetRole: "SAFE",
          targetSecurityId: "sec-ief",
          leadPp: null,
        }),
      );
      const report = await service.getReport(userId);
      expect(report.signal?.relative.applied).toBe(false);
      expect(report.signal?.target?.symbol).toBe("IEF");
    });

    it("reports a HOLD as having nothing to execute", async () => {
      signalService.materialize.mockResolvedValue({
        signals: [storedSignal({ previousRole: "EM_EQUITY" })],
        legacyPeriods: 0,
      });
      const report = await service.getReport(userId);
      expect(report.history[0]).toMatchObject({
        action: "HOLD",
        executed: null,
        change: null,
      });
    });

    it("returns the unconfigured shape for a user with no strategy", async () => {
      strategyRepo.findOne.mockResolvedValue(null);

      const report = await service.getReport(userId);

      expect(report.signal).toBeNull();
      expect(report.position).toBeNull();
      expect(report.action).toBeNull();
      expect(report.performance).toBeNull();
      expect(report.history).toEqual([]);
      expect(report.assets.every((asset) => asset.securityId === null)).toBe(
        true,
      );
      expect(report.warnings.map((warning) => warning.code)).toEqual([
        "FIRST_RUN",
        "UNMAPPED_ROLE",
        "NO_ACCOUNT",
      ]);
      // The unconfigured report still reports a lookback the form can show.
      expect(report.strategy).toMatchObject({
        lookbackMonths: 12,
        taxRatePercent: null,
        commissionAmount: null,
      });
      // No strategy exists yet, so there is no id -- and emphatically not a
      // stand-in string. The client sends this back as ?strategyId=, which
      // every endpoint validates as a UUID, so a sentinel here rejected the
      // first save every new user ever made.
      expect(report.strategy.id).toBeNull();
      expect(report.strategies).toEqual([]);
      expect(signalService.materialize).not.toHaveBeenCalled();
    });

    it("names the roles that have no instrument", async () => {
      assetRepo.find.mockResolvedValue([
        storedAssets()[0],
        { role: "SAFE", securityId: null, security: null },
      ] as GemStrategyAsset[]);

      const report = await service.getReport(userId);

      expect(
        report.warnings.find((warning) => warning.code === "UNMAPPED_ROLE")
          ?.roles,
      ).toEqual(["EX_US_EQUITY", "EM_EQUITY", "SAFE"]);
    });

    it("does not call the optional risk-free role a gap", async () => {
      // Every required role is filled and RISK_FREE is not; the strategy runs
      // on the safe asset as its yardstick, so there is nothing to warn about.
      const report = await service.getReport(userId);

      expect(
        report.warnings.some((warning) => warning.code === "UNMAPPED_ROLE"),
      ).toBe(false);
    });

    it("reports the benchmark the stored evaluation actually used", async () => {
      assetRepo.find.mockResolvedValue([
        ...storedAssets(),
        {
          role: "RISK_FREE",
          securityId: "sec-bil",
          security: { symbol: "BIL", name: "T-Bills" },
        },
      ] as GemStrategyAsset[]);
      signalService.currentSignal.mockReturnValue(
        storedSignal({
          benchmarkRole: "RISK_FREE",
          momentum: { US_EQUITY: 15.42, SAFE: 4.21, RISK_FREE: 5.13 },
        }),
      );

      const report = await service.getReport(userId);

      expect(report.signal?.absolute.benchmark).toMatchObject({
        role: "RISK_FREE",
        symbol: "BIL",
        momentum12m: 5.13,
      });
    });

    it("reads a pre-split evaluation as measured against the safe asset", async () => {
      signalService.currentSignal.mockReturnValue(
        storedSignal({ benchmarkRole: null }),
      );

      const report = await service.getReport(userId);

      expect(report.signal?.absolute.benchmark).toMatchObject({
        role: "SAFE",
        symbol: "IEF",
        momentum12m: 4.21,
      });
    });

    it("warns that the current period could not be evaluated", async () => {
      signalService.currentSignal.mockReturnValue(null);
      const report = await service.getReport(userId);
      expect(report.signal).toBeNull();
      expect(report.warnings.map((w) => w.code)).toContain(
        "CALCULATION_FAILED",
      );
    });

    it("says how many periods an earlier configuration is holding back", async () => {
      // The history and the backtest carry one configuration's decisions only.
      // Left unsaid, the table just comes up short with nothing explaining it.
      signalService.materialize.mockResolvedValue({
        signals: [storedSignal()],
        legacyPeriods: 3,
      });

      const report = await service.getReport(userId);

      expect(
        report.warnings.find((warning) => warning.code === "LEGACY_PERIODS"),
      ).toEqual({ code: "LEGACY_PERIODS", count: 3 });
    });

    it("says nothing about legacy periods when there are none", async () => {
      const report = await service.getReport(userId);
      expect(report.warnings.map((warning) => warning.code)).not.toContain(
        "LEGACY_PERIODS",
      );
    });

    it("warns about a first run when nothing has been evaluated", async () => {
      signalService.materialize.mockResolvedValue({
        signals: [],
        legacyPeriods: 0,
      });
      signalService.currentSignal.mockReturnValue(null);
      const report = await service.getReport(userId);
      expect(report.warnings.map((w) => w.code)).toContain("FIRST_RUN");
      expect(report.warnings.map((w) => w.code)).not.toContain(
        "CALCULATION_FAILED",
      );
    });

    it("does not call a strategy with legacy history a first run", async () => {
      // Every period in the window was decided by an earlier configuration or
      // an earlier algorithm version, so `signals` is empty -- but the
      // strategy has been running for years, and "this strategy has not been
      // evaluated yet" is simply false. `LEGACY_PERIODS` says what happened.
      signalService.materialize.mockResolvedValue({
        signals: [],
        legacyPeriods: 24,
      });
      signalService.currentSignal.mockReturnValue(null);

      const report = await service.getReport(userId);

      expect(report.warnings.map((w) => w.code)).not.toContain("FIRST_RUN");
      expect(report.warnings.map((w) => w.code)).toContain("LEGACY_PERIODS");
    });

    it("rebuilds the report when the configuration changed under it", async () => {
      // materialize reloads the stored configuration under its lock. If that
      // is not the one this report was built from, the halves describe
      // different strategies: signals filtered against a fingerprint the
      // metadata does not match, a backtest replaying one configuration's
      // decisions with another's safe asset and costs. Start again.
      signalService.materialize
        .mockResolvedValueOnce({
          signals: [],
          legacyPeriods: 0,
          configChanged: true,
        })
        .mockResolvedValueOnce({
          signals: [storedSignal()],
          legacyPeriods: 0,
          configChanged: false,
        });

      const report = await service.getReport(userId);

      expect(signalService.materialize).toHaveBeenCalledTimes(2);
      expect(report.history).toHaveLength(1);
    });

    it("gives up rebuilding after one restart", async () => {
      // A user saving faster than the report can be built twice is not a state
      // worth spinning on, and the second attempt is coherent either way.
      signalService.materialize.mockResolvedValue({
        signals: [storedSignal()],
        legacyPeriods: 0,
        configChanged: true,
      });

      await service.getReport(userId);

      expect(signalService.materialize).toHaveBeenCalledTimes(2);
    });

    it("warns about incomplete history when a role has no momentum", async () => {
      signalService.currentSignal.mockReturnValue(
        storedSignal({
          momentum: { US_EQUITY: 15.42, SAFE: 4.21, EM_EQUITY: null },
        }),
      );
      const report = await service.getReport(userId);
      expect(report.warnings.map((w) => w.code)).toContain(
        "INCOMPLETE_HISTORY",
      );
    });

    it("warns about incomplete history when the chart window is partial", async () => {
      performanceService.build.mockResolvedValue({
        range: "1Y",
        points: [],
        totals: {},
        currencyCode: "USD",
        incomplete: true,
      });
      const report = await service.getReport(userId);
      expect(report.warnings.map((w) => w.code)).toContain(
        "INCOMPLETE_HISTORY",
      );
    });

    it("warns about a missing account and an empty account distinctly", async () => {
      positionService.build.mockResolvedValue({
        position: null,
        action: null,
        noPosition: false,
      });
      let report = await service.getReport(userId);
      expect(report.warnings.map((w) => w.code)).toContain("NO_ACCOUNT");

      positionService.build.mockResolvedValue({
        position: {
          accounts: [{ id: "acct-1", name: "Broker IRA" }],
          current: null,
          target: null,
          compliancePercent: null,
          changeRequired: true,
          currencyCode: "USD",
        },
        action: { required: true, executed: false },
        noPosition: true,
      });
      report = await service.getReport(userId);
      expect(report.warnings.map((w) => w.code)).toContain("NO_POSITION");
    });

    it("warns when the prices behind the report are stale", async () => {
      priceService.latestPriceDates.mockImplementation((ids: string[]) =>
        Promise.resolve(new Map(ids.map((id) => [id, "2025-07-02"]))),
      );
      const report = await service.getReport(userId);
      expect(report.warnings.map((w) => w.code)).toContain("STALE_PRICES");
    });

    it("does not let one fresh quote hide a stale instrument", async () => {
      // The regression: staleness was judged on MAX(price_date) across every
      // mapped security, so a US quote refreshed this morning spoke for an
      // ex-US instrument last priced six weeks earlier.
      priceService.latestPriceDates.mockResolvedValue(
        new Map([
          ["sec-spy", "2025-08-13"],
          ["sec-ewa", "2025-07-02"],
          ["sec-emim", "2025-08-13"],
          ["sec-ief", "2025-08-13"],
        ]),
      );

      const report = await service.getReport(userId);

      const stale = report.warnings.find((w) => w.code === "STALE_PRICES");
      expect(stale).toBeDefined();
      // And it names the one to go and refresh.
      expect(stale?.roles).toEqual(["EX_US_EQUITY"]);
      // The report is only as current as its oldest input.
      expect(report.strategy.pricesAsOf).toBe("2025-07-02");
    });

    it("reports an unpriced instrument as unknown, not as everyone else's date", async () => {
      priceService.latestPriceDates.mockResolvedValue(
        new Map([
          ["sec-spy", "2025-08-13"],
          ["sec-emim", "2025-08-13"],
          ["sec-ief", "2025-08-13"],
        ]),
      );

      const report = await service.getReport(userId);

      expect(report.strategy.pricesAsOf).toBeNull();
      expect(
        report.warnings.find((w) => w.code === "STALE_PRICES")?.roles,
      ).toEqual(["EX_US_EQUITY"]);
    });

    it("passes the requested range through to the performance series", async () => {
      await service.getReport(userId, "5Y");
      // The chart is a percentage comparison on listing-currency closes -- the
      // same basis the signal is decided on -- so no currency is passed.
      expect(performanceService.build).toHaveBeenCalledWith(
        expect.objectContaining({ range: "5Y" }),
      );
      expect(performanceService.build.mock.calls[0][0]).not.toHaveProperty(
        "currencyCode",
      );
    });
  });

  describe("updateConfig", () => {
    it("creates the configuration and assigns the roles", async () => {
      strategyRepo.findOne
        .mockResolvedValueOnce(null) // upsert path: nothing stored yet
        .mockResolvedValue(storedStrategy());
      assetRepo.find
        .mockResolvedValueOnce([])
        .mockResolvedValue(storedAssets());
      strategyAccountRepo.find.mockResolvedValue([]); // nothing linked yet
      accountRepo.find.mockResolvedValue([{ id: "acct-1" }, { id: "acct-2" }]);

      await service.updateConfig(userId, {
        accountIds: ["acct-1", "acct-2"],
        cadence: "QUARTERLY",
        lookbackMonths: 12,
        taxRatePercent: 19,
        commissionAmount: 29.9,
        rulesSourceUrl: "https://example.test/gem",
        rulesSourceLabel: "example.test/gem",
        assets: [{ role: "EM_EQUITY", securityId: "sec-emim" }],
      });

      // A scenario always has a name; without one it takes the default.
      expect(strategyRepo.create).toHaveBeenCalledWith({
        userId,
        name: "GEM",
      });
      const [saved] = strategyRepo.save.mock.calls[0];
      expect(saved).toMatchObject({ cadence: "QUARTERLY" });
      const [savedLinks] = strategyAccountRepo.save.mock.calls[0];
      expect(savedLinks).toEqual([
        expect.objectContaining({ accountId: "acct-1", userId }),
        expect.objectContaining({ accountId: "acct-2", userId }),
      ]);
      const [savedAsset] = assetRepo.save.mock.calls[0];
      expect(savedAsset).toMatchObject({
        role: "EM_EQUITY",
        securityId: "sec-emim",
        userId,
      });
    });

    it("fetches the missing price history before evaluating", async () => {
      await service.updateConfig(userId, {
        assets: [{ role: "EM_EQUITY", securityId: "sec-emim" }],
      });

      // Every assigned role is passed, not just the one the save changed: the
      // first signal needs history for all of them.
      expect(backfillService.ensureHistory).toHaveBeenCalledWith(
        userId,
        ["sec-spy", "sec-ewa", "sec-emim", "sec-ief"],
        12,
        // The cadence too: it decides how far back the signal history reaches.
        "MONTHLY",
      );
      // And the report is read after the history lands, not before.
      expect(signalService.materialize).toHaveBeenCalled();
    });

    it("clears a role when the security is null", async () => {
      assetRepo.find.mockResolvedValueOnce([
        { role: "SAFE", securityId: "sec-ief" } as GemStrategyAsset,
      ]);
      await service.updateConfig(userId, {
        assets: [{ role: "SAFE", securityId: null }],
      });
      const [savedAsset] = assetRepo.save.mock.calls[0];
      expect(savedAsset.securityId).toBeNull();
    });

    it("rejects an account that is not the caller's", async () => {
      accountRepo.find.mockResolvedValue([]);
      await expect(
        service.updateConfig(userId, { accountIds: ["acct-other"] }),
      ).rejects.toThrow(NotFoundException);
      expect(strategyRepo.save).not.toHaveBeenCalled();
    });

    it("unlinks an account dropped from the set", async () => {
      strategyAccountRepo.find.mockResolvedValueOnce([
        { accountId: "acct-1", account: { id: "acct-1", name: "Broker IRA" } },
      ]);
      accountRepo.find.mockResolvedValue([{ id: "acct-2" }]);

      await service.updateConfig(userId, { accountIds: ["acct-2"] });

      const [removed] = strategyAccountRepo.remove.mock.calls[0];
      expect(removed).toEqual([
        expect.objectContaining({ accountId: "acct-1" }),
      ]);
    });

    it("clears every account when an empty set is sent", async () => {
      await service.updateConfig(userId, { accountIds: [] });
      const [removed] = strategyAccountRepo.remove.mock.calls[0];
      expect(removed).toHaveLength(1);
      expect(strategyAccountRepo.save).not.toHaveBeenCalled();
    });

    it("rejects a security that is not the caller's", async () => {
      securityRepo.find.mockResolvedValue([]);
      await expect(
        service.updateConfig(userId, {
          assets: [{ role: "EM_EQUITY", securityId: "sec-other" }],
        }),
      ).rejects.toThrow(NotFoundException);
      expect(assetRepo.save).not.toHaveBeenCalled();
    });

    it("leaves untouched fields alone", async () => {
      await service.updateConfig(userId, { taxRatePercent: 0 });
      const [saved] = strategyRepo.save.mock.calls[0];
      expect(saved.taxRatePercent).toBe(0);
      expect(saved.cadence).toBe("MONTHLY");
      expect(assetRepo.save).not.toHaveBeenCalled();
      expect(strategyAccountRepo.remove).not.toHaveBeenCalled();
    });
  });

  describe("markExecuted", () => {
    it("records the execution and returns the refreshed report", async () => {
      const report = await service.markExecuted(userId, "sig-1", "3M");
      expect(signalService.markExecuted).toHaveBeenCalledWith(userId, "sig-1");
      expect(performanceService.build).toHaveBeenCalledWith(
        expect.objectContaining({ range: "3M" }),
      );
      expect(report.signal?.id).toBe("sig-1");
    });

    it("rejects an unknown signal", async () => {
      signalService.markExecuted.mockResolvedValue(false);
      await expect(service.markExecuted(userId, "sig-x")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("scenarios", () => {
    it("reports on the named scenario, not the first one", async () => {
      await service.getReport(userId, "1Y", "strategy-2");

      expect(strategyRepo.findOne).toHaveBeenCalledWith({
        where: { id: "strategy-2", userId },
        order: { createdAt: "ASC" },
      });
    });

    it("carries every saved scenario so the switcher can offer them", async () => {
      strategyRepo.find.mockResolvedValue([
        storedStrategy({ id: "strategy-1", name: "GEM 12m" }),
        storedStrategy({ id: "strategy-2", name: "GEM 6m" }),
      ]);

      const report = await service.getReport(userId);

      expect(report.strategies).toEqual([
        { id: "strategy-1", name: "GEM 12m" },
        { id: "strategy-2", name: "GEM 6m" },
      ]);
      expect(report.strategy.name).toBe("GEM");
    });

    it("creates a named scenario and reports on it", async () => {
      strategyRepo.save.mockResolvedValue(
        storedStrategy({ id: "strategy-2", name: "IKZE quarterly" }),
      );

      await service.createStrategy(userId, "  IKZE quarterly  ");

      expect(strategyRepo.create).toHaveBeenCalledWith({
        userId,
        name: "IKZE quarterly",
      });
      // The report is read back for the scenario just created, not the first.
      expect(strategyRepo.findOne).toHaveBeenCalledWith({
        where: { id: "strategy-2", userId },
        order: { createdAt: "ASC" },
      });
    });

    it("names a scenario created without one", async () => {
      strategyRepo.save.mockResolvedValue(storedStrategy({ id: "strategy-2" }));
      await service.createStrategy(userId, "   ");
      expect(strategyRepo.create).toHaveBeenCalledWith({
        userId,
        name: "GEM",
      });
    });

    it("renames a scenario, trimming the name", async () => {
      await service.updateConfig(userId, { name: "  GEM 6m  " });
      expect(strategyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: "GEM 6m" }),
      );
    });

    it("keeps the existing name when the new one is blank", async () => {
      strategyRepo.findOne.mockResolvedValue(
        storedStrategy({ name: "IKE monthly" }),
      );

      await service.updateConfig(userId, { name: "   " });

      expect(strategyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: "IKE monthly" }),
      );
    });

    it("deletes a scenario and falls back to what is left", async () => {
      await service.removeStrategy(userId, "strategy-2");

      expect(strategyRepo.remove).toHaveBeenCalled();
      // The report afterwards names no scenario, so it lands on the first one.
      expect(strategyRepo.findOne).toHaveBeenLastCalledWith({
        where: { userId },
        order: { createdAt: "ASC" },
      });
    });

    it("refuses to touch a scenario the user does not own", async () => {
      strategyRepo.findOne.mockResolvedValue(null);

      await expect(
        service.removeStrategy(userId, "strategy-9"),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.updateConfig(
          userId,
          { cadence: "QUARTERLY" },
          "1Y",
          "strategy-9",
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(strategyRepo.remove).not.toHaveBeenCalled();
    });
  });

  it("writes a role once when the caller sends it twice", async () => {
    // Two rows for the same (strategy_id, role) hit the unique index and 500.
    // The last value the caller sent is the one they meant.
    assetRepo.find.mockResolvedValue([]);
    securityRepo.find.mockResolvedValue([{ id: "sec-a" }, { id: "sec-emim" }]);

    await service.updateConfig(userId, {
      assets: [
        { role: "EM_EQUITY", securityId: "sec-a" },
        { role: "EM_EQUITY", securityId: "sec-emim" },
      ],
    });

    const saved = assetRepo.save.mock.calls.filter(
      ([asset]) => asset.role === "EM_EQUITY",
    );
    expect(saved).toHaveLength(1);
    expect(saved[0][0].securityId).toBe("sec-emim");
  });

  it("reads configuration through the scoped database only", async () => {
    await service.getReport(userId);
    expect(manager.getRepository).toHaveBeenCalledWith(GemStrategy);
    // No scenario named: the oldest one, which is the only one for a user who
    // never created a second.
    expect(strategyRepo.findOne).toHaveBeenCalledWith({
      where: { userId },
      order: { createdAt: "ASC" },
    });
  });
});
