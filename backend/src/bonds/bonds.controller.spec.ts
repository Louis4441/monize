import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ParseUUIDPipe,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import { SeriesFetchError, SeriesFetchErrorCode } from "./bond-adapter";
import { BondCatalogService } from "./bond-catalog.service";
import { SERIES_ERROR_FALLBACKS } from "./bond-series-errors";
import { BondSeriesService } from "./bond-series.service";
import { EnterBondSeriesDto } from "./dto/enter-bond-series.dto";
import { FetchBondSeriesDto } from "./dto/fetch-bond-series.dto";
import { ROLES_KEY, RolesGuard } from "../auth/guards/roles.guard";
import {
  BondDataInconsistentError,
  BondDataNotFoundError,
} from "./bond-errors";
import { BondPriceService } from "./bond-price.service";
import { todayYMD } from "../common/date-utils";
import { BondOfferService } from "./bond-offer.service";
import { BondValuationService } from "./bond-valuation.service";
import { BOND_ERROR_FALLBACKS, BondsController } from "./bonds.controller";
import { tr } from "../i18n/translate";
import enErrors from "../i18n/locales/en/errors.json";
import { BondEngineError } from "./engine/bond-engine";

// Passes the fallback through, as the real `tr` does without a request context,
// and records the key it was asked for.
jest.mock("../i18n/translate", () => ({
  tr: jest.fn((_key: string, fallback: string) => fallback),
}));

const USER = "11111111-1111-4111-8111-111111111111";
const SECURITY = "22222222-2222-4222-8222-222222222222";
const req = { user: { id: USER } };

describe("BondsController", () => {
  let controller: BondsController;
  let catalog: { listInstruments: jest.Mock };
  let valuation: { valueSecurity: jest.Mock; scenariosOf: jest.Mock };
  let prices: { recomputeSecurity: jest.Mock };
  let series: { fetchSeries: jest.Mock; enterManually: jest.Mock };
  let offers: { offer: jest.Mock; history: jest.Mock };

  beforeEach(async () => {
    catalog = { listInstruments: jest.fn().mockResolvedValue([]) };
    valuation = {
      valueSecurity: jest.fn().mockResolvedValue({ lots: [] }),
      scenariosOf: jest.fn().mockResolvedValue({ scenarios: [] }),
    };
    prices = {
      recomputeSecurity: jest
        .fn()
        .mockResolvedValue({ written: 2, deleted: 1 }),
    };
    series = {
      fetchSeries: jest.fn().mockResolvedValue({ id: "i1", created: true }),
      enterManually: jest.fn().mockResolvedValue({ id: "i1", created: true }),
    };
    offers = {
      offer: jest.fn().mockResolvedValue({ series: [] }),
      history: jest.fn().mockResolvedValue({ programs: [] }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [BondsController],
      providers: [
        { provide: BondSeriesService, useValue: series },
        { provide: BondCatalogService, useValue: catalog },
        { provide: BondValuationService, useValue: valuation },
        { provide: BondPriceService, useValue: prices },
        { provide: BondOfferService, useValue: offers },
      ],
    }).compile();
    controller = moduleRef.get(BondsController);
  });

  it("guards every route with the JWT strategy", () => {
    const guards = new Reflector().get("__guards__", BondsController) ?? [];
    expect(guards).toHaveLength(1);
    expect(guards[0].name).toBe(AuthGuard("jwt").name);
  });

  describe("GET /bonds/instruments", () => {
    it("returns the catalog", async () => {
      const list = [
        {
          id: "i1",
          issuerCountryCode: "PL",
          issuerCode: "PL_MF",
          programCode: "TOS",
          seriesCode: "TOS1029",
          currencyCode: "PLN",
          termsProvider: "curated",
        },
      ];
      catalog.listInstruments.mockResolvedValue(list);
      await expect(controller.listInstruments()).resolves.toEqual(list);
    });
  });

  describe("GET /bonds/securities/:securityId/valuation", () => {
    it("values for the JWT's user, never one the request names, on the asked day", async () => {
      await controller.valuationOf(
        { user: { id: USER }, body: { userId: "attacker" } },
        SECURITY,
        "2027-04-15",
      );
      expect(valuation.valueSecurity).toHaveBeenCalledWith(
        USER,
        SECURITY,
        "2027-04-15",
        undefined,
      );
    });

    it("passes the parsed assumption as the projection", async () => {
      const assume = new Map([["PL_CPI_GUS_YOY", "0.05"]]);
      await controller.valuationOf(req, SECURITY, "2027-04-15", assume);
      expect(valuation.valueSecurity).toHaveBeenCalledWith(
        USER,
        SECURITY,
        "2027-04-15",
        assume,
      );
    });

    it("defaults asOf to today", async () => {
      await controller.valuationOf(req, SECURITY, undefined);
      const [, , asOf] = valuation.valueSecurity.mock.calls[0];
      expect(asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("lets the 404 of another user's or an unlinked security through", async () => {
      valuation.valueSecurity.mockRejectedValue(new NotFoundException("no"));
      await expect(
        controller.valuationOf(req, SECURITY, "2027-04-15"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      [
        new BondDataNotFoundError(
          "TERMS_NOT_FOUND",
          { series: "TOS1029" },
          "English log text",
        ),
        NotFoundException,
        "No terms version is stored for series TOS1029",
      ],
      [
        new BondDataInconsistentError(
          "TERMS_MISMATCH",
          {
            series: "TOS1029",
            version: "1",
            claimedSeries: "TOS1030",
            claimedCurrency: "PLN",
            storedSeries: "TOS1029",
            storedCurrency: "EUR",
          },
          "English log text",
        ),
        UnprocessableEntityException,
        "Terms version 1 of series TOS1029 describe TOS1030 in PLN, but the instrument is TOS1029 in EUR",
      ],
      [
        new BondEngineError(
          "QUANTITY_INVALID",
          { quantity: "0" },
          "English log text",
        ),
        BadRequestException,
        "The quantity must be a positive whole number of bonds: 0",
      ],
      [
        new BondEngineError(
          "BENCHMARK_NOT_READ",
          { series: "EDO1036", benchmarkId: "PL_NBP_REFERENCE" },
          "English log text",
        ),
        BadRequestException,
        "Series EDO1036 does not read the benchmark PL_NBP_REFERENCE",
      ],
    ])(
      "maps %p to an HTTP error built from its code and params, never its message",
      async (error, type, message) => {
        valuation.valueSecurity.mockRejectedValue(error);
        const failure = controller.valuationOf(req, SECURITY, "2027-04-15");
        await expect(failure).rejects.toBeInstanceOf(type);
        await expect(failure).rejects.toThrow(message);
        await expect(failure).rejects.not.toThrow("English log text");
      },
    );

    it("does not swallow an unexpected failure as a bond error", async () => {
      valuation.valueSecurity.mockRejectedValue(new Error("connection reset"));
      await expect(
        controller.valuationOf(req, SECURITY, "2027-04-15"),
      ).rejects.toThrow("connection reset");
    });
  });

  describe("error message keys", () => {
    const codes = Object.keys(BOND_ERROR_FALLBACKS);

    it.each(codes)(
      "%s selects errors.bonds.%s, which the English catalogue carries",
      async (code) => {
        (tr as jest.Mock).mockClear();
        valuation.valueSecurity.mockRejectedValue(
          new BondEngineError(code as never, {}, "English log text"),
        );
        await expect(
          controller.valuationOf(req, SECURITY, "2027-04-15"),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect((tr as jest.Mock).mock.calls[0][0]).toBe(`errors.bonds.${code}`);
        expect((enErrors.bonds as Record<string, string>)[code]).toEqual(
          expect.any(String),
        );
      },
    );
  });

  describe("GET /bonds/offer", () => {
    it("reads the offer for the JWT's user, never one the request names, with the parsed assumption", async () => {
      const assume = new Map([["PL_CPI_GUS_YOY", "0.05"]]);
      await controller.offer(
        { user: { id: USER }, body: { userId: "attacker" } },
        "PL",
        assume,
      );
      expect(offers.offer).toHaveBeenCalledWith(USER, "PL", assume);
    });

    it("lets a stored-data refusal become its HTTP error", async () => {
      offers.offer.mockRejectedValue(
        new BondEngineError("DECIMAL_INVALID", { field: "x", value: "y" }, "x"),
      );
      await expect(controller.offer(req, "PL")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("GET /bonds/history", () => {
    it("reads the history of a country, one program when named", async () => {
      await controller.history("PL", "EDO");
      expect(offers.history).toHaveBeenCalledWith("PL", "EDO");
      await controller.history("PL");
      expect(offers.history).toHaveBeenLastCalledWith("PL", undefined);
    });
  });

  describe("GET /bonds/securities/:securityId/scenarios", () => {
    it("values for the JWT's user, today, with the parsed query", async () => {
      await controller.scenariosOf(
        { user: { id: USER }, body: { userId: "attacker" } },
        SECURITY,
        "PL_CPI_GUS_YOY",
        ["0", "0.05"],
      );
      expect(valuation.scenariosOf).toHaveBeenCalledWith(
        USER,
        SECURITY,
        "PL_CPI_GUS_YOY",
        ["0", "0.05"],
        todayYMD(),
      );
    });

    it("values as of the asOf the card asks for", async () => {
      await controller.scenariosOf(
        req,
        SECURITY,
        "PL_CPI_GUS_YOY",
        ["0"],
        "2027-03-01",
      );
      expect(valuation.scenariosOf.mock.calls[0][4]).toBe("2027-03-01");
    });

    it("lets the 404 of another user's or an unlinked security through", async () => {
      valuation.scenariosOf.mockRejectedValue(new NotFoundException("no"));
      await expect(
        controller.scenariosOf(req, SECURITY, "PL_CPI_GUS_YOY", ["0"]),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("maps the data errors like the valuation does", async () => {
      valuation.scenariosOf.mockRejectedValue(
        new BondDataInconsistentError("TERMS_MISMATCH", {}, "x"),
      );
      await expect(
        controller.scenariosOf(req, SECURITY, "PL_CPI_GUS_YOY", ["0"]),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  describe("POST /bonds/securities/:securityId/recompute", () => {
    it("recomputes for the JWT's user and returns the counts", async () => {
      await expect(controller.recompute(req, SECURITY)).resolves.toEqual({
        written: 2,
        deleted: 1,
      });
      expect(prices.recomputeSecurity).toHaveBeenCalledWith(USER, SECURITY);
    });

    it("maps the data errors the same way", async () => {
      prices.recomputeSecurity.mockRejectedValue(
        new BondDataNotFoundError("INSTRUMENT_NOT_FOUND", {}, "No instrument"),
      );
      await expect(controller.recompute(req, SECURITY)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("route parameters", () => {
    it("takes the security id through ParseUUIDPipe and asOf through the no-future date pipe", () => {
      const pipesOf = (method: keyof BondsController) => {
        const args = Reflect.getMetadata(
          "__routeArguments__",
          BondsController,
          method as string,
        ) as Record<string, { data: string; pipes: unknown[] }>;
        return Object.values(args).map((a) => [
          a.data,
          a.pipes.map((p) =>
            typeof p === "function" ? p.name : (p as object).constructor.name,
          ),
        ]);
      };
      expect(pipesOf("valuationOf")).toEqual(
        expect.arrayContaining([
          ["securityId", [ParseUUIDPipe.name]],
          ["asOf", ["ParseBondAsOfPipe"]],
        ]),
      );
      expect(pipesOf("valuationOf")).toEqual(
        expect.arrayContaining([["assume", ["ParseAssumePipe"]]]),
      );
      expect(pipesOf("scenariosOf")).toEqual(
        expect.arrayContaining([
          ["securityId", [ParseUUIDPipe.name]],
          ["benchmarkId", ["ParseBenchmarkIdPipe"]],
          ["values", ["ParseScenarioValuesPipe"]],
          ["asOf", ["ParseBondAsOfPipe"]],
        ]),
      );
      expect(pipesOf("recompute")).toEqual(
        expect.arrayContaining([["securityId", [ParseUUIDPipe.name]]]),
      );
    });
  });

  describe("POST /bonds/instruments/fetch", () => {
    const dto = { countryCode: "PL", seriesCode: "EDO1036" };

    it("hands only the country and the series code to the service", async () => {
      await expect(controller.fetchSeries(dto)).resolves.toEqual({
        id: "i1",
        created: true,
      });
      expect(series.fetchSeries).toHaveBeenCalledWith("PL", "EDO1036");
    });

    it("is throttled to 10 requests a minute", () => {
      const handler = BondsController.prototype.fetchSeries;
      expect(Reflect.getMetadata("THROTTLER:LIMITdefault", handler)).toBe(10);
      expect(Reflect.getMetadata("THROTTLER:TTLdefault", handler)).toBe(60_000);
    });

    it("needs no role beyond the JWT", () => {
      expect(
        Reflect.getMetadata(
          "__guards__",
          BondsController.prototype.fetchSeries,
        ),
      ).toBeUndefined();
    });

    it.each([
      ["SERIES_CODE_INVALID", BadRequestException],
      ["SERIES_FETCH_UNSUPPORTED", BadRequestException],
      ["SERIES_NOT_PUBLISHED", NotFoundException],
      ["SOURCE_UNAVAILABLE", ServiceUnavailableException],
      ["SOURCE_FORMAT_CHANGED", BadGatewayException],
      ["SOURCE_INCONSISTENT", UnprocessableEntityException],
      ["TEMPLATE_NOT_VALIDATED", UnprocessableEntityException],
      ["SERIES_TERMS_CONFLICT", ConflictException],
    ] as Array<[SeriesFetchErrorCode, new (...args: never[]) => Error]>)(
      "maps %s to its HTTP error with the translated message",
      async (code, exception) => {
        (tr as jest.Mock).mockClear();
        series.fetchSeries.mockRejectedValue(
          new SeriesFetchError(code, { series: "EDO1036", country: "PL" }),
        );
        await expect(controller.fetchSeries(dto)).rejects.toBeInstanceOf(
          exception,
        );
        expect((tr as jest.Mock).mock.calls[0][0]).toBe(`errors.bonds.${code}`);
        expect((enErrors.bonds as Record<string, string>)[code]).toEqual(
          expect.any(String),
        );
      },
    );

    it("lets anything that is not a refusal through", async () => {
      series.fetchSeries.mockRejectedValue(new Error("db down"));
      await expect(controller.fetchSeries(dto)).rejects.toThrow("db down");
    });
  });

  describe("POST /bonds/instruments/manual", () => {
    const dto = {
      countryCode: "PL",
      seriesCode: "EDO1036",
      values: {
        firstPeriodRate: "0.0535",
        addend: "0.0200",
        fee: "2.00",
        saleWindow: { from: "2026-10-01", to: "2026-10-31" },
        letter: { number: "12/2026", date: "2026-09-21" },
      },
    } as EnterBondSeriesDto;

    it("is behind the administrator role", () => {
      const handler = BondsController.prototype.enterSeries;
      expect(Reflect.getMetadata("__guards__", handler)).toEqual([RolesGuard]);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(["admin"]);
    });

    it("passes the values to the service, an empty optional as null", async () => {
      await controller.enterSeries({
        ...dto,
        values: { ...dto.values, addend: "", fee: undefined },
      });
      expect(series.enterManually).toHaveBeenCalledWith("PL", "EDO1036", {
        firstPeriodRate: "0.0535",
        addend: null,
        fee: null,
        saleWindow: { from: "2026-10-01", to: "2026-10-31" },
        letter: { number: "12/2026", date: "2026-09-21" },
      });
    });

    it("maps a refused value to 422, and a conflict to 409", async () => {
      series.enterManually.mockRejectedValueOnce(
        new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: "fee" }),
      );
      await expect(controller.enterSeries(dto)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      series.enterManually.mockRejectedValueOnce(
        new SeriesFetchError("SERIES_TERMS_CONFLICT"),
      );
      await expect(controller.enterSeries(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe("series messages", () => {
    it("has an English source for every code that reads the same as the catalogue", () => {
      const params = {
        series: "<series>",
        country: "<country>",
        field: "<field>",
        detail: "<detail>",
        product: "<product>",
        validFrom: "<validFrom>",
      };
      const codes = Object.keys(
        SERIES_ERROR_FALLBACKS,
      ) as SeriesFetchErrorCode[];
      expect(codes).toHaveLength(8);
      for (const code of codes) {
        const catalogue = (enErrors.bonds as Record<string, string>)[code];
        const interpolated = catalogue.replace(
          /\{\{ (\w+) \}\}/g,
          (_m, name: string) => params[name as keyof typeof params],
        );
        expect(SERIES_ERROR_FALLBACKS[code](params)).toBe(interpolated);
      }
    });
  });

  describe("series DTOs", () => {
    const check = async (cls: new () => object, plain: object) =>
      (
        await validate(plainToInstance(cls, plain), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).map((e) => e.property);

    it("accepts a country and a series code and nothing else", async () => {
      expect(
        await check(FetchBondSeriesDto, {
          countryCode: "PL",
          seriesCode: "EDO1036",
        }),
      ).toEqual([]);
      expect(
        await check(FetchBondSeriesDto, {
          countryCode: "PL",
          seriesCode: "EDO1036",
          firstPeriodRate: "0.99",
        }),
      ).toEqual(["firstPeriodRate"]);
    });

    it.each([
      [{ countryCode: "pl", seriesCode: "EDO1036" }, "countryCode"],
      [{ countryCode: "POL", seriesCode: "EDO1036" }, "countryCode"],
      [{ countryCode: "PL", seriesCode: "EDO1036/../x" }, "seriesCode"],
      [{ countryCode: "PL", seriesCode: "A".repeat(17) }, "seriesCode"],
      [{ countryCode: "PL" }, "seriesCode"],
    ])("refuses %j", async (body, property) => {
      expect(await check(FetchBondSeriesDto, body)).toContain(property);
    });

    const values = {
      firstPeriodRate: "0.0535",
      addend: "0.0200",
      fee: "2.00",
      saleWindow: { from: "2026-10-01", to: "2026-10-31" },
      letter: { number: "12/2026", date: "2026-09-21" },
    };

    it("accepts the values of a template, the optional ones absent or null", async () => {
      const base = { countryCode: "PL", seriesCode: "EDO1036" };
      expect(await check(EnterBondSeriesDto, { ...base, values })).toEqual([]);
      expect(
        await check(EnterBondSeriesDto, {
          ...base,
          values: { ...values, addend: null, fee: undefined },
        }),
      ).toEqual([]);
    });

    it.each([
      ["a rate that is not a decimal", { firstPeriodRate: "5,35%" }],
      ["a rate with a thousand digits", { firstPeriodRate: "1".repeat(1000) }],
      ["an addend that is not a decimal", { addend: "x" }],
      ["a fee that is not a decimal", { fee: "-1" }],
      [
        "a window date that is not a date",
        { saleWindow: { from: "10/01/2026", to: "2026-10-31" } },
      ],
      [
        "a letter number over 32 characters",
        { letter: { number: "1".repeat(33), date: "2026-09-21" } },
      ],
      [
        "a letter date that is not a date",
        { letter: { number: "12/2026", date: "yesterday" } },
      ],
    ])("refuses %s", async (_label, change) => {
      const errors = await validate(
        plainToInstance(EnterBondSeriesDto, {
          countryCode: "PL",
          seriesCode: "EDO1036",
          values: { ...values, ...change },
        }),
        { whitelist: true, forbidNonWhitelisted: true },
      );
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
