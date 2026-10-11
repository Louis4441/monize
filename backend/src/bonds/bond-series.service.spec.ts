import { Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { acquireAdvisoryLock, LockScope } from "../common/db/locks";
import { withSystemContext } from "../common/db/with-context";
import {
  FetchSyncJob,
  FetchSyncService,
} from "../common/jobs/fetch-sync.service";
import { ProviderHealthService } from "../provider-health/provider-health.service";
import { ProviderUnavailableError } from "../provider-health/provider-unavailable.error";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { FIXTURE_CATALOG } from "./adapters/pl/pl-test-input";
import {
  BondAdapter,
  CatalogEntry,
  ManualSeriesValues,
  SeriesFetchError,
} from "./bond-adapter";
import { BenchmarkRefreshService } from "./benchmark-refresh.service";
import { BondCatalogService, StoreOutcome } from "./bond-catalog.service";
import { bondInstrumentId } from "./bond-instrument-id";
import { BondPriceService } from "./bond-price.service";
import {
  BACKFILL_GAP_MS,
  BackfillRun,
  BondSeriesService,
} from "./bond-series.service";
import { SeriesHttp } from "./series-http";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("../common/db/with-context", () => ({
  withSystemContext: jest.fn((fn: () => unknown) => fn()),
}));
jest.mock("../common/db/locks", () => ({
  ...jest.requireActual("../common/db/locks"),
  acquireAdvisoryLock: jest.fn(async () => undefined),
}));

/** Any parsed catalog entry: the service stores whatever the adapter built. */
const ENTRY: CatalogEntry = FIXTURE_CATALOG[0];
const INSTRUMENT_ID = bondInstrumentId("PL", "PL_MF", "OTS0127");
const SUMMARY = {
  id: INSTRUMENT_ID,
  issuerCountryCode: "PL",
  issuerCode: "PL_MF",
  programCode: "OTS",
  seriesCode: "OTS0127",
  currencyCode: "PLN",
  termsProvider: "obligacjeskarbowe.pl",
};
const VALUES: ManualSeriesValues = {
  firstPeriodRate: "0.0200",
  addend: null,
  fee: null,
  saleWindow: { from: "2026-10-01", to: "2026-10-31" },
  letter: { number: "12/2026", date: "2026-09-21" },
};
const gatedDoor = jest.fn();
const NO_BACKFILL: BackfillRun = {
  candidates: 0,
  alreadyStored: 0,
  stored: 0,
  notPublished: 0,
  failed: 0,
  stoppedEarly: false,
};

function adapterOf(over: Partial<BondAdapter> = {}): BondAdapter {
  return {
    countryCode: "PL",
    timezone: "Europe/Warsaw",
    registerCalendars: (r) => r,
    benchmarks: [],
    programs: [],
    fetchBenchmark: jest.fn(),
    seriesProviderId: "obligacjeskarbowe",
    fetchSeries: jest.fn(async () => ({ entry: ENTRY, sources: [] })),
    manualSeries: jest.fn(() => ENTRY),
    currentSeries: jest.fn(async () => []),
    ...over,
  };
}

function build() {
  const { manager, dataSource } = createScopedDbMocks();
  const order: string[] = [];
  const catalog = {
    findStoredSeries: jest.fn(
      async (..._args: unknown[]) => null as typeof SUMMARY | null,
    ),
    storedSeriesCodes: jest.fn(
      async (..._args: unknown[]) => new Set<string>(),
    ),
    findSummary: jest.fn(async () => SUMMARY as typeof SUMMARY | null),
    seedBenchmarkSeries: jest.fn(async (..._args: unknown[]) => undefined),
    storeEntry: jest.fn(async (): Promise<StoreOutcome> => ({
      kind: "inserted",
      named: "PL PL_MF OTS0127",
      instrumentId: INSTRUMENT_ID,
    })),
  };
  (acquireAdvisoryLock as jest.Mock).mockImplementation(async () => {
    order.push("lock");
  });
  catalog.storeEntry.mockImplementation(async () => {
    order.push("store");
    return {
      kind: "inserted",
      named: "PL PL_MF OTS0127",
      instrumentId: INSTRUMENT_ID,
    };
  });
  const http = { gated: jest.fn(() => gatedDoor) };
  const health = { logFailure: jest.fn() };
  const fetchSync = {
    withLease: jest.fn(
      async (_job: string, _ms: number, fn: () => Promise<void>) => {
        await fn();
        return true;
      },
    ),
  };
  manager.query.mockResolvedValue([]);
  const prices = { recomputeLinkedSecuritiesOfSeries: jest.fn() };
  const benchmarks = { refreshNeverFetched: jest.fn() };
  const service = new BondSeriesService(
    dataSource as unknown as DataSource,
    catalog as unknown as BondCatalogService,
    http as unknown as SeriesHttp,
    health as unknown as ProviderHealthService,
    fetchSync as unknown as FetchSyncService,
    prices as unknown as BondPriceService,
    benchmarks as unknown as BenchmarkRefreshService,
  );
  return {
    service,
    prices,
    benchmarks,
    catalog,
    http,
    health,
    fetchSync,
    manager,
    dataSource,
    order,
  };
}

const refusal = async (
  promise: Promise<unknown>,
): Promise<SeriesFetchError> => {
  try {
    await promise;
  } catch (error) {
    return error as SeriesFetchError;
  }
  throw new Error("expected a refusal");
};

/**
 * A series stored after a row was written changes how a BUY or REINVEST without
 * one is read (INV-BOND-007): the engine prices of the program's securities are
 * recomputed after the commit (INV-CACHE-001), once per pass.
 */
describe("BondSeriesService: recompute after a series is stored", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "error").mockImplementation();
    jest.spyOn(Logger.prototype, "warn").mockImplementation();
    jest.spyOn(Logger.prototype, "log").mockImplementation();
  });
  afterEach(() => jest.clearAllMocks());

  it("recomputes the program's securities after a fetch that stored a series, and only after the store committed", async () => {
    const { service, prices, order } = build();
    prices.recomputeLinkedSecuritiesOfSeries.mockImplementation(async () => {
      order.push("recompute");
    });
    await service.fetchSeries("PL", "ots0127", { adapters: [adapterOf()] });
    expect(prices.recomputeLinkedSecuritiesOfSeries).toHaveBeenCalledWith([
      INSTRUMENT_ID,
    ]);
    expect(order).toEqual(["lock", "store", "recompute"]);
  });

  it("refreshes a never-fetched benchmark of the stored series after the commit, before the recompute", async () => {
    const { service, prices, benchmarks, order } = build();
    benchmarks.refreshNeverFetched.mockImplementation(async () => {
      order.push("benchmarks");
    });
    prices.recomputeLinkedSecuritiesOfSeries.mockImplementation(async () => {
      order.push("recompute");
    });
    await service.fetchSeries("PL", "ots0127", { adapters: [adapterOf()] });
    expect(benchmarks.refreshNeverFetched).toHaveBeenCalledWith([
      INSTRUMENT_ID,
    ]);
    expect(order).toEqual(["lock", "store", "benchmarks", "recompute"]);
  });

  it("dispatches no benchmark refresh for a series that was already stored or refused", async () => {
    const { service, catalog, benchmarks } = build();
    catalog.findStoredSeries.mockResolvedValue(SUMMARY);
    await service.fetchSeries("PL", "ots0127", { adapters: [adapterOf()] });
    catalog.findStoredSeries.mockResolvedValue(null);
    catalog.storeEntry.mockResolvedValue({
      kind: "conflict",
      named: "PL PL_MF OTS0127",
    } as never);
    await expect(
      service.fetchSeries("PL", "ots0127", { adapters: [adapterOf()] }),
    ).rejects.toBeInstanceOf(SeriesFetchError);
    expect(benchmarks.refreshNeverFetched).toHaveBeenLastCalledWith([]);
    expect(benchmarks.refreshNeverFetched).toHaveBeenCalledTimes(1);
  });

  it("dispatches once for a whole pass, with every series it stored", async () => {
    const { service, benchmarks } = build();
    const adapter = adapterOf({
      currentSeries: jest.fn(async () => ["EDO1036", "ROR1027", "TOS1029"]),
    });
    await service.fetchCurrentOffer({ adapters: [adapter] });
    expect(benchmarks.refreshNeverFetched).toHaveBeenCalledTimes(1);
  });

  it("stores the benchmark row a stored series reads in the store's transaction, and none for a fixed rate", async () => {
    const { service, catalog } = build();
    const edo = FIXTURE_CATALOG.find(
      (e) =>
        (e.terms as { instrument: { seriesCode: string } }).instrument
          .seriesCode === "EDO1036",
    )!;
    const adapter = adapterOf({
      fetchSeries: jest.fn(async () => ({ entry: edo, sources: [] })),
    });
    await service.fetchSeries("PL", "edo1036", { adapters: [adapter] });
    expect(catalog.seedBenchmarkSeries).toHaveBeenCalledWith(
      [adapter],
      new Set(["PL_CPI_GUS_YOY"]),
    );
    catalog.seedBenchmarkSeries.mockClear();
    await service.fetchSeries("PL", "ots0127", { adapters: [adapterOf()] });
    expect(catalog.seedBenchmarkSeries).not.toHaveBeenCalled();
  });

  it("recomputes nothing for a series that was already stored", async () => {
    const { service, catalog, prices } = build();
    catalog.findStoredSeries.mockResolvedValue(SUMMARY);
    await service.fetchSeries("PL", "ots0127", { adapters: [adapterOf()] });
    catalog.findStoredSeries.mockResolvedValue(null);
    catalog.storeEntry.mockResolvedValue({
      kind: "unchanged",
      named: "PL PL_MF OTS0127",
      instrumentId: INSTRUMENT_ID,
    });
    await service.fetchSeries("PL", "ots0127", { adapters: [adapterOf()] });
    expect(prices.recomputeLinkedSecuritiesOfSeries).toHaveBeenLastCalledWith(
      [],
    );
  });

  it("recomputes nothing when the store is refused", async () => {
    const { service, catalog, prices } = build();
    catalog.storeEntry.mockResolvedValue({
      kind: "conflict",
      named: "PL PL_MF OTS0127",
    } as never);
    await expect(
      service.fetchSeries("PL", "ots0127", { adapters: [adapterOf()] }),
    ).rejects.toBeInstanceOf(SeriesFetchError);
    expect(prices.recomputeLinkedSecuritiesOfSeries).not.toHaveBeenCalled();
  });

  it("recomputes after an administrator's manual entry", async () => {
    const { service, prices } = build();
    await service.enterManually("PL", "ots0127", VALUES, {
      adapters: [adapterOf()],
    });
    expect(prices.recomputeLinkedSecuritiesOfSeries).toHaveBeenCalledWith([
      INSTRUMENT_ID,
    ]);
  });

  it("recomputes once for a whole pass of the current offer, not once per series", async () => {
    const { service, prices } = build();
    const adapter = adapterOf({
      currentSeries: jest.fn(async () => ["EDO1036", "ROR1027", "TOS1029"]),
    });
    await service.fetchCurrentOffer({ adapters: [adapter] });
    expect(prices.recomputeLinkedSecuritiesOfSeries).toHaveBeenCalledTimes(1);
    expect(
      prices.recomputeLinkedSecuritiesOfSeries.mock.calls[0][0],
    ).toHaveLength(3);
  });

  it("recomputes once for a whole backfill, and for the user's fetch of the offer", async () => {
    const { service, prices } = build();
    const adapter = adapterOf({
      backfillCodes: jest.fn(() => ["ROR0125", "DOR0126"]),
      currentSeries: jest.fn(async () => ["EDO1036"]),
    });
    await service.backfillHistory({
      adapters: [adapter],
      sleep: jest.fn(async () => undefined),
      today: "2026-10-11",
    });
    expect(prices.recomputeLinkedSecuritiesOfSeries).toHaveBeenCalledTimes(1);
    expect(
      prices.recomputeLinkedSecuritiesOfSeries.mock.calls[0][0],
    ).toHaveLength(2);

    prices.recomputeLinkedSecuritiesOfSeries.mockClear();
    await service.fetchOfferOf("PL", { adapters: [adapter] });
    expect(prices.recomputeLinkedSecuritiesOfSeries).toHaveBeenCalledTimes(1);
  });
});

describe("BondSeriesService", () => {
  let logError: jest.SpyInstance;
  let logWarn: jest.SpyInstance;
  let logLog: jest.SpyInstance;
  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, "error").mockImplementation();
    logWarn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    logLog = jest.spyOn(Logger.prototype, "log").mockImplementation();
  });
  afterEach(() => jest.clearAllMocks());

  describe("fetchSeries", () => {
    it("answers a stored series without fetching anything", async () => {
      const { service, catalog, http } = build();
      const adapter = adapterOf();
      catalog.findStoredSeries.mockResolvedValue(SUMMARY);

      await expect(
        service.fetchSeries("pl", "ots0127", { adapters: [adapter] }),
      ).resolves.toEqual({ ...SUMMARY, created: false });

      expect(catalog.findStoredSeries).toHaveBeenCalledWith(
        expect.anything(),
        "PL",
        "OTS0127",
      );
      expect(adapter.fetchSeries).not.toHaveBeenCalled();
      expect(http.gated).not.toHaveBeenCalled();
      expect(catalog.storeEntry).not.toHaveBeenCalled();
    });

    it("fetches a missing series through the adapter's gated door and stores it under the instrument's lock", async () => {
      const { service, catalog, http, order, manager } = build();
      const adapter = adapterOf();

      await expect(
        service.fetchSeries("PL", "ots0127", { adapters: [adapter] }),
      ).resolves.toEqual({ ...SUMMARY, created: true });

      expect(http.gated).toHaveBeenCalledWith("obligacjeskarbowe", undefined);
      expect(adapter.fetchSeries).toHaveBeenCalledWith("OTS0127", gatedDoor);
      expect(acquireAdvisoryLock).toHaveBeenCalledWith(
        manager,
        LockScope.BondSeriesFetch,
        INSTRUMENT_ID,
      );
      // The lock is the first statement of the write; the store reads inside it.
      expect(order).toEqual(["lock", "store"]);
      expect(catalog.storeEntry).toHaveBeenCalledWith(manager, ENTRY);
    });

    it("keeps the lock key on the deterministic instrument id of the entry", () => {
      expect(INSTRUMENT_ID).toBe(bondInstrumentId("PL", "PL_MF", "OTS0127"));
      expect(LockScope.BondSeriesFetch).toBe(8);
    });

    it("writes nothing for a repeat with the same content", async () => {
      const { service, catalog } = build();
      catalog.storeEntry.mockResolvedValue({
        kind: "unchanged",
        named: "PL PL_MF OTS0127",
        instrumentId: INSTRUMENT_ID,
      });
      await expect(
        service.fetchSeries("PL", "OTS0127", { adapters: [adapterOf()] }),
      ).resolves.toMatchObject({ created: false });
      expect(logLog).not.toHaveBeenCalledWith(
        expect.stringContaining("Stored terms version 1"),
      );
    });

    it.each(["conflict", "instrument-mismatch"] as const)(
      "refuses a %s with SERIES_TERMS_CONFLICT, logged, and reads no summary",
      async (kind) => {
        const { service, catalog } = build();
        catalog.storeEntry.mockResolvedValue({
          kind,
          named: "PL PL_MF OTS0127",
          instrumentId: INSTRUMENT_ID,
          fields: [],
        } as StoreOutcome);
        const error = await refusal(
          service.fetchSeries("PL", "OTS0127", { adapters: [adapterOf()] }),
        );
        expect(error).toBeInstanceOf(SeriesFetchError);
        expect(error.code).toBe("SERIES_TERMS_CONFLICT");
        expect(error.params).toEqual({ country: "PL", series: "OTS0127" });
        expect(logError).toHaveBeenCalledWith(
          expect.stringContaining("nothing was written"),
        );
        expect(catalog.findSummary).not.toHaveBeenCalled();
      },
    );

    it("refuses before writing when the adapter refuses: no lock, no store", async () => {
      const { service, catalog, dataSource } = build();
      const adapter = adapterOf({
        fetchSeries: jest.fn(async () => {
          throw new SeriesFetchError("SOURCE_INCONSISTENT", {
            field: "firstPeriodRate",
            page: "0.04",
            letter: "0.05",
          });
        }),
      });
      const error = await refusal(
        service.fetchSeries("PL", "OTS0127", { adapters: [adapter] }),
      );
      expect(error.code).toBe("SOURCE_INCONSISTENT");
      // The request is named on the params, the adapter's own values kept.
      expect(error.params).toEqual({
        country: "PL",
        series: "OTS0127",
        field: "firstPeriodRate",
        page: "0.04",
        letter: "0.05",
      });
      expect(acquireAdvisoryLock).not.toHaveBeenCalled();
      expect(catalog.storeEntry).not.toHaveBeenCalled();
      // Only the read of the stored series opened a transaction.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("keeps the cause of an unavailable source on the refusal", async () => {
      const cause = new ProviderUnavailableError("X", 1000, null);
      const { service } = build();
      const adapter = adapterOf({
        fetchSeries: jest.fn(async () => {
          throw new SeriesFetchError("SOURCE_UNAVAILABLE", {}, { cause });
        }),
      });
      const error = await refusal(
        service.fetchSeries("PL", "OTS0127", { adapters: [adapter] }),
      );
      expect(error.cause).toBe(cause);
    });

    it("lets an error that is not a refusal through unchanged", async () => {
      const { service } = build();
      const boom = new Error("boom");
      const adapter = adapterOf({
        fetchSeries: jest.fn(async () => {
          throw boom;
        }),
      });
      await expect(
        service.fetchSeries("PL", "OTS0127", { adapters: [adapter] }),
      ).rejects.toBe(boom);
    });

    it("answers SERIES_FETCH_UNSUPPORTED for a country without an adapter, or without a fetch", async () => {
      const { service, http } = build();
      const none = await refusal(
        service.fetchSeries("DE", "ABC1", { adapters: [adapterOf()] }),
      );
      expect(none.code).toBe("SERIES_FETCH_UNSUPPORTED");
      expect(none.params).toEqual({ country: "DE", series: "ABC1" });

      const noFetch = await refusal(
        service.fetchSeries("PL", "OTS0127", {
          adapters: [adapterOf({ fetchSeries: undefined })],
        }),
      );
      expect(noFetch.code).toBe("SERIES_FETCH_UNSUPPORTED");
      const noProvider = await refusal(
        service.fetchSeries("PL", "OTS0127", {
          adapters: [adapterOf({ seriesProviderId: undefined })],
        }),
      );
      expect(noProvider.code).toBe("SERIES_FETCH_UNSUPPORTED");
      expect(http.gated).not.toHaveBeenCalled();
    });

    it("refuses terms the catalog cannot parse as a changed format, writing nothing", async () => {
      const { service, catalog } = build();
      const adapter = adapterOf({
        fetchSeries: jest.fn(async () => ({
          entry: { termsVersion: 1, publishedAt: null, terms: { x: 1 } },
          sources: [],
        })),
      });
      const error = await refusal(
        service.fetchSeries("PL", "OTS0127", { adapters: [adapter] }),
      );
      expect(error.code).toBe("SOURCE_FORMAT_CHANGED");
      expect(error.params).toMatchObject({ field: "terms" });
      expect(catalog.storeEntry).not.toHaveBeenCalled();
    });

    it("refuses an entry the store reports as invalid", async () => {
      const { service, catalog } = build();
      catalog.storeEntry.mockResolvedValue({ kind: "invalid", message: "x" });
      const error = await refusal(
        service.fetchSeries("PL", "OTS0127", { adapters: [adapterOf()] }),
      );
      expect(error.code).toBe("SOURCE_FORMAT_CHANGED");
    });
  });

  describe("enterManually", () => {
    it("builds the entry from the adapter's template and stores it like a fetch", async () => {
      const { service, order } = build();
      const adapter = adapterOf();
      await expect(
        service.enterManually("pl", "ots0127", VALUES, { adapters: [adapter] }),
      ).resolves.toEqual({ ...SUMMARY, created: true });
      expect(adapter.manualSeries).toHaveBeenCalledWith("OTS0127", VALUES);
      expect(adapter.fetchSeries).not.toHaveBeenCalled();
      expect(order).toEqual(["lock", "store"]);
    });

    it("writes nothing when the values are refused", async () => {
      const { service, catalog } = build();
      const adapter = adapterOf({
        manualSeries: jest.fn(() => {
          throw new SeriesFetchError("SOURCE_INCONSISTENT", { field: "fee" });
        }),
      });
      const error = await refusal(
        service.enterManually("PL", "OTS0127", VALUES, { adapters: [adapter] }),
      );
      expect(error.code).toBe("SOURCE_INCONSISTENT");
      expect(error.params).toMatchObject({ series: "OTS0127", field: "fee" });
      expect(catalog.storeEntry).not.toHaveBeenCalled();
    });

    it("is a conflict when the series is stored with other terms", async () => {
      const { service, catalog } = build();
      catalog.storeEntry.mockResolvedValue({
        kind: "conflict",
        named: "PL PL_MF OTS0127",
        instrumentId: INSTRUMENT_ID,
      });
      const error = await refusal(
        service.enterManually("PL", "OTS0127", VALUES, {
          adapters: [adapterOf()],
        }),
      );
      expect(error.code).toBe("SERIES_TERMS_CONFLICT");
    });

    it("is unsupported for an adapter without manual entry", async () => {
      const { service } = build();
      const error = await refusal(
        service.enterManually("PL", "OTS0127", VALUES, {
          adapters: [adapterOf({ manualSeries: undefined })],
        }),
      );
      expect(error.code).toBe("SERIES_FETCH_UNSUPPORTED");
    });

    it("checkManual validates through the adapter and stores nothing", () => {
      const { service, catalog } = build();
      const adapter = adapterOf();
      service.checkManual("PL", "ots0127", VALUES, { adapters: [adapter] });
      expect(adapter.manualSeries).toHaveBeenCalledWith("OTS0127", VALUES);
      expect(catalog.storeEntry).not.toHaveBeenCalled();
      const refusing = adapterOf({
        manualSeries: jest.fn(() => {
          throw new SeriesFetchError("TEMPLATE_NOT_VALIDATED");
        }),
      });
      expect(() =>
        service.checkManual("PL", "OTS0127", VALUES, { adapters: [refusing] }),
      ).toThrow(SeriesFetchError);
    });
  });

  describe("isAdministrator", () => {
    it.each([
      [[{ role: "admin" }], true],
      [[{ role: "user" }], false],
      [[], false],
    ])("reads the role from the user's row: %j", async (rows, expected) => {
      const { service, manager } = build();
      manager.query.mockResolvedValue(rows);
      await expect(service.isAdministrator("u1")).resolves.toBe(expected);
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining("FROM users WHERE id = $1"),
        ["u1"],
      );
    });
  });

  describe("the daily check of the current offer", () => {
    it("runs under a system context around the whole lease, in the bond series lease", async () => {
      const { service, fetchSync } = build();
      jest
        .spyOn(service, "autoFetchPrograms")
        .mockResolvedValue(new Set(["PL|OTS"]));
      jest.spyOn(service, "fetchCurrentOffer").mockResolvedValue({
        listed: 0,
        stored: 0,
        alreadyStored: 0,
        failed: 0,
      });
      const backfill = jest
        .spyOn(service, "backfillHistory")
        .mockResolvedValue(NO_BACKFILL);
      await service.scheduledCurrentOffer();
      expect(backfill).toHaveBeenCalledTimes(1);
      expect(withSystemContext).toHaveBeenCalledTimes(1);
      expect(fetchSync.withLease).toHaveBeenCalledWith(
        FetchSyncJob.BondSeries,
        expect.any(Number),
        expect.any(Function),
      );
      expect(service.fetchCurrentOffer).toHaveBeenCalledTimes(1);
    });

    it("fetches only the programs a security has switched auto-fetch on for, in the offer and the backfill", async () => {
      const { service } = build();
      const programs = new Set(["PL|OTS", "PL|EDO"]);
      jest.spyOn(service, "autoFetchPrograms").mockResolvedValue(programs);
      const offer = jest.spyOn(service, "fetchCurrentOffer").mockResolvedValue({
        listed: 0,
        stored: 0,
        alreadyStored: 0,
        failed: 0,
      });
      const backfill = jest
        .spyOn(service, "backfillHistory")
        .mockResolvedValue(NO_BACKFILL);
      await service.scheduledCurrentOffer();
      expect(offer).toHaveBeenCalledWith({ programs });
      expect(backfill).toHaveBeenCalledWith({ programs });
    });

    it("fetches nothing at all while no security has auto-fetch switched on (off by default)", async () => {
      const { service, fetchSync } = build();
      // The query answers no program.
      const offer = jest.spyOn(service, "fetchCurrentOffer");
      const backfill = jest.spyOn(service, "backfillHistory");
      await service.scheduledCurrentOffer();
      expect(fetchSync.withLease).toHaveBeenCalledTimes(1);
      expect(offer).not.toHaveBeenCalled();
      expect(backfill).not.toHaveBeenCalled();
    });

    it("reads the programs in one query that selects program columns only, never a user's data", async () => {
      const { service, manager } = build();
      manager.query.mockResolvedValue([
        { issuer_country_code: "PL", program_code: "EDO" },
        { issuer_country_code: "PL", program_code: "COI" },
      ]);
      await expect(service.autoFetchPrograms()).resolves.toEqual(
        new Set(["PL|EDO", "PL|COI"]),
      );
      expect(manager.query).toHaveBeenCalledTimes(1);
      const sql = String(manager.query.mock.calls[0][0]);
      expect(sql).toMatch(/FROM bond_programs p/);
      expect(sql).toMatch(/s\.bond_auto_fetch/);
      expect(sql).not.toMatch(/user_id|symbol|securities s\b.*SELECT/);
      expect(sql.split("SELECT")[1]).not.toMatch(/s\./);
    });

    it("does nothing when another replica holds the lease", async () => {
      const { service, fetchSync } = build();
      fetchSync.withLease.mockResolvedValue(false);
      const run = jest.spyOn(service, "fetchCurrentOffer");
      await service.scheduledCurrentOffer();
      expect(run).not.toHaveBeenCalled();
    });

    it("runs the backfill after the offer, and still after an offer that failed, then records that failure", async () => {
      const { service, fetchSync } = build();
      jest
        .spyOn(service, "autoFetchPrograms")
        .mockResolvedValue(new Set(["PL|OTS"]));
      const order: string[] = [];
      jest.spyOn(service, "fetchCurrentOffer").mockImplementation(async () => {
        order.push("offer");
        throw new Error("every series failed");
      });
      jest.spyOn(service, "backfillHistory").mockImplementation(async () => {
        order.push("backfill");
        return NO_BACKFILL;
      });
      await service.scheduledCurrentOffer();
      expect(order).toEqual(["offer", "backfill"]);
      // The lease wrapper saw the offer's failure (and the cron logged it).
      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining("every series failed"),
      );
      expect(fetchSync.withLease).toHaveBeenCalledTimes(1);
    });

    it("holds the lease long enough for the backfill of about 270 series at 3 s each", async () => {
      const { service, fetchSync } = build();
      jest
        .spyOn(service, "autoFetchPrograms")
        .mockResolvedValue(new Set(["PL|OTS"]));
      jest.spyOn(service, "fetchCurrentOffer").mockResolvedValue({
        listed: 0,
        stored: 0,
        alreadyStored: 0,
        failed: 0,
      });
      jest.spyOn(service, "backfillHistory").mockResolvedValue(NO_BACKFILL);
      await service.scheduledCurrentOffer();
      const [, ttl] = fetchSync.withLease.mock.calls[0];
      expect(ttl).toBeGreaterThanOrEqual(270 * BACKFILL_GAP_MS * 2);
    });

    it("never dies on a failed run", async () => {
      const { service, fetchSync } = build();
      fetchSync.withLease.mockRejectedValue(new Error("lease table gone"));
      await expect(service.scheduledCurrentOffer()).resolves.toBeUndefined();
      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining("lease table gone"),
      );
    });

    it("fetches only the listed series the catalog lacks", async () => {
      const { service, catalog } = build();
      const adapter = adapterOf({
        currentSeries: jest.fn(async () => ["EDO1036", "ROR1027", "TOS1029"]),
      });
      catalog.findStoredSeries.mockImplementation(async (_m, _c, code) =>
        (code as unknown as string) === "ROR1027" ? SUMMARY : null,
      );
      const run = await service.fetchCurrentOffer({ adapters: [adapter] });
      expect(run).toEqual({
        listed: 3,
        stored: 2,
        alreadyStored: 1,
        failed: 0,
      });
      expect(adapter.currentSeries).toHaveBeenCalledWith(gatedDoor);
      expect(adapter.fetchSeries).toHaveBeenCalledTimes(2);
      expect(adapter.fetchSeries).not.toHaveBeenCalledWith(
        "ROR1027",
        expect.anything(),
      );
      expect(logLog).toHaveBeenCalledWith(
        "Bond series check: 3 listed, 2 stored, 1 already stored, 0 failed",
      );
    });

    it("isolates one failing series from the others", async () => {
      const { service, health } = build();
      const cause = new ProviderUnavailableError("X", 1000, null);
      const adapter = adapterOf({
        currentSeries: jest.fn(async () => ["EDO1036", "ROR1027", "TOS1029"]),
        fetchSeries: jest.fn(async (code: string) => {
          if (code === "ROR1027") {
            throw new SeriesFetchError("SOURCE_UNAVAILABLE", {}, { cause });
          }
          return { entry: ENTRY, sources: [] };
        }),
      });
      const run = await service.fetchCurrentOffer({ adapters: [adapter] });
      expect(run).toMatchObject({ stored: 2, failed: 1 });
      expect(adapter.fetchSeries).toHaveBeenCalledTimes(3);
      expect(health.logFailure).toHaveBeenCalledWith(
        expect.anything(),
        "obligacjeskarbowe",
        expect.stringContaining("ROR1027"),
        cause,
      );
    });

    it("logs a refusal that is not a transport failure as a warning with its code", async () => {
      const { service } = build();
      const adapter = adapterOf({
        currentSeries: jest.fn(async () => ["EDO1036", "ROR1027"]),
        fetchSeries: jest.fn(async (code: string) => {
          if (code === "EDO1036") {
            throw new SeriesFetchError("SERIES_NOT_PUBLISHED");
          }
          return { entry: ENTRY, sources: [] };
        }),
      });
      await service.fetchCurrentOffer({ adapters: [adapter] });
      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining("SERIES_NOT_PUBLISHED"),
      );
    });

    it("counts an unreadable offer as a failure and carries on with the next adapter", async () => {
      const { service } = build();
      const broken = adapterOf({
        currentSeries: jest.fn(async () => {
          throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", {
            field: "currentOffer",
          });
        }),
      });
      const other = adapterOf({
        countryCode: "XX",
        currentSeries: jest.fn(async () => ["ABC1"]),
      });
      const run = await service.fetchCurrentOffer({
        adapters: [broken, other],
      });
      expect(run).toMatchObject({ listed: 1, stored: 1, failed: 1 });
    });

    it("throws when everything attempted failed, so the lease records a failure", async () => {
      const { service } = build();
      const adapter = adapterOf({
        currentSeries: jest.fn(async () => ["EDO1036"]),
        fetchSeries: jest.fn(async () => {
          throw new SeriesFetchError("SOURCE_UNAVAILABLE");
        }),
      });
      await expect(
        service.fetchCurrentOffer({ adapters: [adapter] }),
      ).rejects.toThrow(/Every bond series check failed \(1\)/);
    });

    it("skips an adapter that cannot list its offer or fetch", async () => {
      const { service } = build();
      const run = await service.fetchCurrentOffer({
        adapters: [
          adapterOf({ currentSeries: undefined }),
          adapterOf({ fetchSeries: undefined }),
          adapterOf({ seriesProviderId: undefined }),
        ],
      });
      expect(run).toEqual({
        listed: 0,
        stored: 0,
        alreadyStored: 0,
        failed: 0,
      });
    });
  });

  describe("program scope (auto-fetch, spec 2.5)", () => {
    const programAdapter = (codes: string[]) =>
      adapterOf({
        currentSeries: jest.fn(async () => codes),
        backfillCodes: jest.fn(() => codes),
        programOf: (code: string) => code.slice(0, 3),
      });

    it("fetches only the series of the programs in scope", async () => {
      const { service } = build();
      const adapter = programAdapter(["EDO1036", "ROR1027", "COI1030"]);
      const run = await service.fetchCurrentOffer({
        adapters: [adapter],
        programs: new Set(["PL|EDO", "PL|COI"]),
      });
      expect(run.listed).toBe(2);
      const fetched = (adapter.fetchSeries as jest.Mock).mock.calls.map(
        (c) => c[0],
      );
      expect(fetched).toEqual(["EDO1036", "COI1030"]);
    });

    it("leaves an adapter that cannot name a series' program out of scope", async () => {
      const { service } = build();
      const adapter = adapterOf({
        currentSeries: jest.fn(async () => ["EDO1036"]),
      });
      const run = await service.fetchCurrentOffer({
        adapters: [adapter],
        programs: new Set(["PL|EDO"]),
      });
      expect(run.listed).toBe(0);
      expect(adapter.fetchSeries).not.toHaveBeenCalled();
    });

    it("backfills only the programs in scope", async () => {
      const { service } = build();
      const adapter = programAdapter(["EDO1036", "ROR1027"]);
      const run = await service.backfillHistory({
        adapters: [adapter],
        programs: new Set(["PL|ROR"]),
        sleep: async () => undefined,
        today: "2026-10-11",
      });
      expect(run.candidates).toBe(1);
      expect(
        (adapter.fetchSeries as jest.Mock).mock.calls.map((c) => c[0]),
      ).toEqual(["ROR1027"]);
    });

    it("with no program filter every series is in scope (an explicit request)", async () => {
      const { service } = build();
      const adapter = programAdapter(["EDO1036", "ROR1027"]);
      const run = await service.fetchCurrentOffer({ adapters: [adapter] });
      expect(run.listed).toBe(2);
    });
  });

  describe("fetchOfferOf (the user's fetch of the current offer now)", () => {
    it("fetches every series of the country's offer the catalog lacks and counts them", async () => {
      const { service, catalog } = build();
      const adapter = adapterOf({
        currentSeries: jest.fn(async () => ["EDO1036", "ROR1027", "TOS1029"]),
      });
      catalog.findStoredSeries.mockImplementation(async (_m, _c, code) =>
        (code as unknown as string) === "ROR1027" ? SUMMARY : null,
      );
      await expect(
        service.fetchOfferOf("pl", { adapters: [adapter] }),
      ).resolves.toEqual({
        listed: 3,
        stored: 2,
        alreadyStored: 1,
        failed: 0,
      });
    });

    it("refuses a country with no official source", async () => {
      const { service } = build();
      const error = await refusal(
        service.fetchOfferOf("DE", { adapters: [adapterOf()] }),
      );
      expect(error.code).toBe("SERIES_FETCH_UNSUPPORTED");
    });

    it("reports a source that cannot be read as failed instead of throwing", async () => {
      const { service } = build();
      const adapter = adapterOf({
        currentSeries: jest.fn(async () => {
          throw new SeriesFetchError("SOURCE_UNAVAILABLE");
        }),
      });
      await expect(
        service.fetchOfferOf("PL", { adapters: [adapter] }),
      ).resolves.toEqual({ listed: 0, stored: 0, alreadyStored: 0, failed: 1 });
    });
  });

  describe("fetchProgramOffer (the refresh of a linked security)", () => {
    it("fetches only the codes of the program on sale now", async () => {
      const { service } = build();
      const adapter = adapterOf({
        currentSeries: jest.fn(async () => ["EDO1036", "ROR1027", "EDO1035"]),
        programOf: (code: string) => code.slice(0, 3),
      });
      const run = await service.fetchProgramOffer("pl", "edo", {
        adapters: [adapter],
      });
      expect(run.listed).toBe(2);
      expect(
        (adapter.fetchSeries as jest.Mock).mock.calls.map((c) => c[0]),
      ).toEqual(["EDO1036", "EDO1035"]);
    });

    it("refuses a country with no official source", async () => {
      const { service } = build();
      const error = await refusal(
        service.fetchProgramOffer("DE", "EDO", { adapters: [adapterOf()] }),
      );
      expect(error.code).toBe("SERIES_FETCH_UNSUPPORTED");
    });
  });

  describe("backfillHistory", () => {
    const codes = ["OTS0424", "ROR0125", "DOR0126", "TOS0127"];
    const withCodes = (over: Partial<BondAdapter> = {}) =>
      adapterOf({ backfillCodes: jest.fn(() => codes), ...over });

    it("asks the adapter for its codes and the catalog, once, which are stored, and fetches only the rest", async () => {
      const { service, catalog } = build();
      const adapter = withCodes();
      catalog.storedSeriesCodes.mockResolvedValue(
        new Set(["OTS0424", "TOS0127"]),
      );
      const sleep = jest.fn(async () => undefined);
      const run = await service.backfillHistory({
        adapters: [adapter],
        sleep,
        today: "2026-10-11",
      });
      expect(adapter.backfillCodes).toHaveBeenCalledWith("2026-10-11");
      expect(catalog.storedSeriesCodes).toHaveBeenCalledTimes(1);
      expect(catalog.storedSeriesCodes).toHaveBeenCalledWith(
        expect.anything(),
        "PL",
        codes,
      );
      // Only the two that are not stored are fetched.
      expect(adapter.fetchSeries).toHaveBeenCalledTimes(2);
      expect(adapter.fetchSeries).toHaveBeenNthCalledWith(
        1,
        "ROR0125",
        gatedDoor,
      );
      expect(adapter.fetchSeries).toHaveBeenNthCalledWith(
        2,
        "DOR0126",
        gatedDoor,
      );
      expect(run).toEqual({
        candidates: 4,
        alreadyStored: 2,
        stored: 2,
        notPublished: 0,
        failed: 0,
        stoppedEarly: false,
      });
    });

    it("waits 3 seconds before each request and never when everything is stored", async () => {
      const { service, catalog } = build();
      const events: string[] = [];
      const adapter = withCodes({
        fetchSeries: jest.fn(async (code: string) => {
          events.push(`fetch ${code}`);
          return { entry: ENTRY, sources: [] };
        }),
      });
      const sleep = jest.fn(async (ms: number) => {
        events.push(`sleep ${ms}`);
      });
      await service.backfillHistory({
        adapters: [adapter],
        sleep,
        today: "2026-10-11",
      });
      expect(BACKFILL_GAP_MS).toBe(3000);
      expect(events).toEqual([
        "sleep 3000",
        "fetch OTS0424",
        "sleep 3000",
        "fetch ROR0125",
        "sleep 3000",
        "fetch DOR0126",
        "sleep 3000",
        "fetch TOS0127",
      ]);

      catalog.storedSeriesCodes.mockResolvedValue(new Set(codes));
      sleep.mockClear();
      const rerun = await service.backfillHistory({
        adapters: [adapter],
        sleep,
        today: "2026-10-11",
      });
      expect(sleep).not.toHaveBeenCalled();
      expect(rerun).toMatchObject({ stored: 0, alreadyStored: 4 });
    });

    it("stops on the first SOURCE_UNAVAILABLE and asks for nothing more", async () => {
      const { service } = build();
      const fetchSeries = jest
        .fn()
        .mockResolvedValueOnce({ entry: ENTRY, sources: [] })
        .mockRejectedValueOnce(new SeriesFetchError("SOURCE_UNAVAILABLE"));
      const sleep = jest.fn(async () => undefined);
      const run = await service.backfillHistory({
        adapters: [withCodes({ fetchSeries })],
        sleep,
        today: "2026-10-11",
      });
      expect(fetchSeries).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(run).toMatchObject({ stored: 1, failed: 1, stoppedEarly: true });
      expect(logLog).toHaveBeenCalledWith(
        expect.stringContaining("stopped on an unavailable source"),
      );
    });

    it("goes on after a series the source does not publish, and after any other refusal, logging each", async () => {
      const { service } = build();
      const fetchSeries = jest
        .fn()
        .mockRejectedValueOnce(new SeriesFetchError("SERIES_NOT_PUBLISHED"))
        .mockRejectedValueOnce(new SeriesFetchError("SOURCE_INCONSISTENT"))
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ entry: ENTRY, sources: [] });
      const run = await service.backfillHistory({
        adapters: [withCodes({ fetchSeries })],
        sleep: async () => undefined,
        today: "2026-10-11",
      });
      expect(fetchSeries).toHaveBeenCalledTimes(4);
      expect(run).toEqual({
        candidates: 4,
        alreadyStored: 0,
        stored: 1,
        notPublished: 1,
        failed: 2,
        stoppedEarly: false,
      });
      expect(logWarn).toHaveBeenCalledTimes(3);
    });

    it("skips an adapter without a backfill, and takes the adapter's own today by default", async () => {
      const { service, catalog } = build();
      const plain = adapterOf();
      const run = await service.backfillHistory({
        adapters: [plain],
        sleep: async () => undefined,
      });
      expect(run.candidates).toBe(0);
      expect(catalog.storedSeriesCodes).not.toHaveBeenCalled();

      const adapter = withCodes();
      await service.backfillHistory({
        adapters: [adapter],
        sleep: async () => undefined,
      });
      expect(adapter.backfillCodes).toHaveBeenCalledWith(
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      );
    });
  });
});
