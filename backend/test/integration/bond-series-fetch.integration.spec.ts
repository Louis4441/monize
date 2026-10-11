import { Reflector } from "@nestjs/core";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { acquireAdvisoryLock, LockScope } from "@/common/db/locks";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { ROLES_KEY, RolesGuard } from "@/auth/guards/roles.guard";
import { POLISH_BOND_ADAPTER } from "@/bonds/adapters/pl/index";
import {
  fakeFetch,
  fakePdfText,
  letterFixture,
  SLUGS,
  seriesRoutes,
} from "@/bonds/adapters/pl/series/fixture-helpers";
import { extractPdfText } from "@/bonds/adapters/pl/series/pdf-text";
import {
  BondAdapter,
  BondFetch,
  ManualSeriesValues,
} from "@/bonds/bond-adapter";
import { BondCatalogService } from "@/bonds/bond-catalog.service";
import { bondInstrumentId } from "@/bonds/bond-instrument-id";
import { BondSeriesService } from "@/bonds/bond-series.service";
import { BondsController } from "@/bonds/bonds.controller";
import { SeriesHttp } from "@/bonds/series-http";
import { CurrenciesService } from "@/currencies/currencies.service";
import { ProviderHealthService } from "@/provider-health/provider-health.service";
import { FetchSyncService } from "@/common/jobs/fetch-sync.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";

// The letter is read as text: the fake PDF is the magic plus the saved letter
// text, so the real adapter parses the real fixture without pdfjs.
jest.mock("@/bonds/adapters/pl/series/pdf-text", () => ({
  extractPdfText: jest.fn(),
}));

const CODE = "EDO1036";
const INSTRUMENT_ID = bondInstrumentId("PL", "PL_MF", CODE);
const PAGE_URL = `https://www.obligacjeskarbowe.pl/oferta-obligacji/${SLUGS.EDO}/edo1036/`;
// The values of the October 2026 EDO letter, as an administrator would type them.
const VALUES: ManualSeriesValues = {
  firstPeriodRate: "0.0535",
  addend: "0.0200",
  fee: "3.00",
  saleWindow: { from: "2026-10-01", to: "2026-10-31" },
  letter: { number: "99/2026", date: "2026-09-21" },
};

/**
 * `docs/specs/bond-series-fetch.md` section 7, "Write" and "Manual" (INV-BOND-006)
 * against a real PostgreSQL, with a fake `BondFetch` over the saved issuer pages
 * and letters -- never the network. The transaction, the advisory lock, the
 * content-hash comparison and the rollback are properties of SQL a mocked
 * manager cannot show.
 */
describe("bond series fetch (integration, INV-BOND-006)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let catalog: BondCatalogService;
  let service: BondSeriesService;
  let door: jest.MockedFunction<BondFetch>;
  let adminId: string;
  let userId: string;
  let otherId: string;

  /** The adapter, fetching through `door` whatever `SeriesHttp` is asked. */
  const adapter: BondAdapter = POLISH_BOND_ADAPTER;

  const build = (): BondSeriesService =>
    new BondSeriesService(
      dataSource,
      catalog,
      { gated: () => door } as unknown as SeriesHttp,
      new ProviderHealthService(dataSource),
      new FetchSyncService(dataSource),
    );

  /** A request as a signed-in user makes it. */
  const asUser = <T>(id: string, fn: () => Promise<T>) =>
    withUserContext(id, fn);
  const fetchAs = (id: string, code = CODE, adapters = [adapter]) =>
    asUser(id, () => service.fetchSeries("PL", code, { adapters }));
  const enterAs = (
    id: string,
    values: ManualSeriesValues = VALUES,
    adapters = [adapter],
  ) =>
    asUser(id, () => service.enterManually("PL", CODE, values, { adapters }));

  const curatedEdo = () =>
    adapter.catalog.find(
      (e) =>
        (e.terms as { instrument: { seriesCode: string } }).instrument
          .seriesCode === CODE,
    )!;
  const count = async (table: string): Promise<number> =>
    Number(
      (await dataSource.query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n,
    );
  const versions = () =>
    dataSource.query(
      `SELECT version, content_hash, source_url,
              TO_CHAR(published_at, 'YYYY-MM-DD') AS published_at,
              terms -> 'source' ->> 'provider' AS provider,
              terms -> 'source' ->> 'document' AS document,
              retrieved_at::text AS retrieved_at
         FROM bond_terms_versions`,
    );
  const refusalOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as { code: string; params: Record<string, string> };
    }
    throw new Error("expected a refusal");
  };

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
    catalog = new BondCatalogService(
      dataSource,
      new CurrenciesService(dataSource),
    );
    adminId = (await createTestUserDirect(dataSource, { role: "admin" })).id;
    userId = (await createTestUserDirect(dataSource)).id;
    otherId = (await createTestUserDirect(dataSource)).id;
  });

  afterAll(async () => {
    await dataSource.query(`DELETE FROM users WHERE id = ANY($1)`, [
      [adminId, userId, otherId],
    ]);
    await module.close();
  });

  beforeEach(async () => {
    (extractPdfText as jest.Mock).mockImplementation(async (b: Uint8Array) =>
      fakePdfText(b),
    );
    await cleanTables(dataSource, ["bond_programs", "bond_instruments"]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('PLN', 'Zloty', 'z', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    door = fakeFetch(seriesRoutes(CODE, SLUGS.EDO));
    service = build();
  });

  afterEach(() => jest.restoreAllMocks());

  describe("Write", () => {
    it("a fetch inserts one instrument and terms version 1, naming the official source", async () => {
      await expect(fetchAs(userId)).resolves.toMatchObject({
        id: INSTRUMENT_ID,
        seriesCode: CODE,
        issuerCountryCode: "PL",
        currencyCode: "PLN",
        termsProvider: "obligacjeskarbowe.pl",
        created: true,
      });

      expect(await count("bond_instruments")).toBe(1);
      // The program is stored with its first series, in the same transaction.
      expect(await count("bond_programs")).toBe(1);
      const stored = await versions();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        version: 1,
        source_url: PAGE_URL,
        published_at: "2026-09-21",
        provider: "obligacjeskarbowe.pl",
        document: "List emisyjny nr 99/2026",
      });
      expect(stored[0].content_hash).toHaveLength(64);
    });

    it("a repeat fetches nothing and writes nothing", async () => {
      await fetchAs(userId);
      const before = await versions();
      door.mockClear();

      await expect(fetchAs(otherId)).resolves.toMatchObject({
        id: INSTRUMENT_ID,
        created: false,
      });

      expect(door).not.toHaveBeenCalled();
      expect(await count("bond_instruments")).toBe(1);
      expect(await versions()).toEqual(before);
    });

    it("a series stored by the curated seed is answered without a fetch", async () => {
      await withUserContext(userId, () =>
        withScopedDb(dataSource, (m) => catalog.storeEntry(m, curatedEdo())),
      );
      door.mockClear();
      await expect(
        asUser(userId, () =>
          service.fetchSeries("PL", "EDO1036", { adapters: [adapter] }),
        ),
      ).resolves.toMatchObject({ created: false, termsProvider: "PL_MF" });
      expect(door).not.toHaveBeenCalled();
    });

    it("a fetch whose content differs from the stored version 1 is SERIES_TERMS_CONFLICT and writes nothing", async () => {
      // A concurrent writer commits a different version 1 while this request is
      // reading the source, after its own check that the series is absent.
      const racing: BondAdapter = {
        ...adapter,
        fetchSeries: async (code, fetch) => {
          await enterAs(adminId);
          return adapter.fetchSeries!(code, fetch);
        },
      };
      const error = await refusalOf(fetchAs(userId, CODE, [racing]));

      expect(error.code).toBe("SERIES_TERMS_CONFLICT");
      expect(error.params).toEqual({ country: "PL", series: CODE });
      const stored = await versions();
      expect(stored).toHaveLength(1);
      expect(stored[0].provider).toBe("manual");
      expect(await count("bond_instruments")).toBe(1);
    });

    it("a manual entry over a fetched series is refused the same way, and the fetched version stays", async () => {
      await fetchAs(userId);
      const [fetched] = await versions();
      const error = await refusalOf(enterAs(adminId));
      expect(error.code).toBe("SERIES_TERMS_CONFLICT");
      expect(await versions()).toEqual([fetched]);
    });

    it("a refused fetch leaves no row: the letter disagrees with the page", async () => {
      door = fakeFetch(
        seriesRoutes(CODE, SLUGS.EDO, {
          letter: letterFixture(CODE).replace("5,35%", "5,40%"),
        }),
      );
      service = build();

      const error = await refusalOf(fetchAs(userId));

      expect(error.code).toBe("SOURCE_INCONSISTENT");
      expect(error.params).toMatchObject({ field: "firstPeriodRate" });
      expect(await count("bond_instruments")).toBe(0);
      expect(await count("bond_programs")).toBe(0);
      expect(await count("bond_terms_versions")).toBe(0);
    });

    it("a series the issuer does not publish is SERIES_NOT_PUBLISHED and leaves no row", async () => {
      door = fakeFetch({
        [PAGE_URL]: { status: 404, body: new Uint8Array() },
      });
      service = build();
      const error = await refusalOf(fetchAs(userId));
      expect(error.code).toBe("SERIES_NOT_PUBLISHED");
      expect(await count("bond_instruments")).toBe(0);
    });

    it("an unsupported country is refused before anything is fetched", async () => {
      const error = await refusalOf(
        asUser(userId, () =>
          service.fetchSeries("DE", CODE, { adapters: [adapter] }),
        ),
      );
      expect(error.code).toBe("SERIES_FETCH_UNSUPPORTED");
      expect(door).not.toHaveBeenCalled();
    });

    it("a failure after the insert rolls the whole store back", async () => {
      const store = catalog.storeEntry.bind(catalog);
      jest
        .spyOn(catalog, "storeEntry")
        .mockImplementationOnce(async (m, entry) => {
          await store(m, entry);
          throw new Error("later step failed");
        });
      await expect(fetchAs(userId)).rejects.toThrow("later step failed");
      expect(await count("bond_instruments")).toBe(0);
      expect(await count("bond_terms_versions")).toBe(0);
    });

    it("two concurrent fetches of one series insert once", async () => {
      const results = await Promise.all([
        fetchAs(userId),
        fetchAs(otherId),
        fetchAs(adminId),
      ]);

      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(results.filter((r) => !r.created)).toHaveLength(2);
      expect(new Set(results.map((r) => r.id))).toEqual(
        new Set([INSTRUMENT_ID]),
      );
      expect(await count("bond_instruments")).toBe(1);
      expect(await count("bond_terms_versions")).toBe(1);
    });

    it("the instrument's advisory lock holds a second writer until the first commits", async () => {
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await acquireAdvisoryLock(
          runner.manager,
          LockScope.BondSeriesFetch,
          INSTRUMENT_ID,
        );
        let settled = false;
        const pending = fetchAs(userId).finally(() => {
          settled = true;
        });
        // The network read is outside the lock; the store waits on it.
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled).toBe(false);
        expect(await count("bond_terms_versions")).toBe(0);

        await runner.commitTransaction();
        await expect(pending).resolves.toMatchObject({ created: true });
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }
      expect(await count("bond_terms_versions")).toBe(1);
    });
  });

  describe("Manual", () => {
    const guardAllows = async (id: string): Promise<boolean> => {
      // The role the JWT strategy would put on the request: the user's own row.
      const [{ role }] = await dataSource.query(
        `SELECT role FROM users WHERE id = $1`,
        [id],
      );
      const handler = BondsController.prototype.enterSeries;
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(["admin"]);
      return new RolesGuard(new Reflector()).canActivate({
        getHandler: () => handler,
        getClass: () => BondsController,
        switchToHttp: () => ({ getRequest: () => ({ user: { id, role } }) }),
      } as never);
    };

    it("refuses a non-administrator (403 at the guard, and the tools' role check) and an administrator passes", async () => {
      expect(await guardAllows(userId)).toBe(false);
      expect(await guardAllows(adminId)).toBe(true);
      await expect(
        asUser(userId, () => service.isAdministrator(userId)),
      ).resolves.toBe(false);
      await expect(
        asUser(adminId, () => service.isAdministrator(adminId)),
      ).resolves.toBe(true);
      expect(await count("bond_instruments")).toBe(0);
    });

    it("an administrator's entry is stored with provider manual, on the template", async () => {
      await expect(enterAs(adminId)).resolves.toMatchObject({
        id: INSTRUMENT_ID,
        termsProvider: "manual",
        created: true,
      });
      const [stored] = await versions();
      expect(stored).toMatchObject({
        version: 1,
        provider: "manual",
        document: "List emisyjny nr 99/2026",
        source_url: PAGE_URL,
        published_at: "2026-09-21",
      });
      // The structure comes from the template: the terms are the fetched ones
      // but for their source.
      const [manual] = await dataSource.query(
        `SELECT terms - 'source' AS terms FROM bond_terms_versions`,
      );
      const { entry } = await adapter.fetchSeries!(CODE, door);
      const { source: _source, ...fetched } = entry.terms as Record<
        string,
        unknown
      >;
      expect(manual.terms).toEqual(fetched);
    });

    it("a repeat of the same entry writes nothing", async () => {
      await enterAs(adminId);
      const before = await versions();
      await expect(enterAs(adminId)).resolves.toMatchObject({ created: false });
      expect(await versions()).toEqual(before);
    });

    it.each([
      [
        "a fee above the bound",
        { ...VALUES, fee: "99.00" },
        "SOURCE_INCONSISTENT",
      ],
      [
        "a first-period rate above the bound",
        { ...VALUES, firstPeriodRate: "0.9000" },
        "SOURCE_INCONSISTENT",
      ],
      [
        "a sale window outside the code's sale month",
        { ...VALUES, saleWindow: { from: "2026-11-01", to: "2026-11-30" } },
        "SOURCE_INCONSISTENT",
      ],
      [
        "a letter dated after the sale starts",
        { ...VALUES, letter: { number: "99/2026", date: "2026-10-05" } },
        "SOURCE_INCONSISTENT",
      ],
      [
        "a rate that is not a decimal",
        { ...VALUES, firstPeriodRate: "5,35%" },
        "SOURCE_FORMAT_CHANGED",
      ],
    ])("%s is refused and leaves no row", async (_label, values, code) => {
      const error = await refusalOf(enterAs(adminId, values));
      expect(error.code).toBe(code);
      expect(await count("bond_instruments")).toBe(0);
      expect(await count("bond_terms_versions")).toBe(0);
    });
  });
});
