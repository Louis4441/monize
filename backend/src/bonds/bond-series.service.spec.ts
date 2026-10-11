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
import { POLISH_BOND_ADAPTER } from "./adapters/pl";
import {
  BondAdapter,
  CatalogEntry,
  ManualSeriesValues,
  SeriesFetchError,
} from "./bond-adapter";
import { BondCatalogService, StoreOutcome } from "./bond-catalog.service";
import { bondInstrumentId } from "./bond-instrument-id";
import { BondSeriesService } from "./bond-series.service";
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
const ENTRY: CatalogEntry = POLISH_BOND_ADAPTER.catalog[0];
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

function adapterOf(over: Partial<BondAdapter> = {}): BondAdapter {
  return {
    countryCode: "PL",
    timezone: "Europe/Warsaw",
    registerCalendars: (r) => r,
    benchmarks: [],
    catalog: [],
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
    findSummary: jest.fn(async () => SUMMARY as typeof SUMMARY | null),
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
  const service = new BondSeriesService(
    dataSource as unknown as DataSource,
    catalog as unknown as BondCatalogService,
    http as unknown as SeriesHttp,
    health as unknown as ProviderHealthService,
    fetchSync as unknown as FetchSyncService,
  );
  return {
    service,
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
      jest.spyOn(service, "fetchCurrentOffer").mockResolvedValue({
        listed: 0,
        stored: 0,
        alreadyStored: 0,
        failed: 0,
      });
      await service.scheduledCurrentOffer();
      expect(withSystemContext).toHaveBeenCalledTimes(1);
      expect(fetchSync.withLease).toHaveBeenCalledWith(
        FetchSyncJob.BondSeries,
        expect.any(Number),
        expect.any(Function),
      );
      expect(service.fetchCurrentOffer).toHaveBeenCalledTimes(1);
    });

    it("does nothing when another replica holds the lease", async () => {
      const { service, fetchSync } = build();
      fetchSync.withLease.mockResolvedValue(false);
      const run = jest.spyOn(service, "fetchCurrentOffer");
      await service.scheduledCurrentOffer();
      expect(run).not.toHaveBeenCalled();
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
});
