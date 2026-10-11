import {
  BadRequestException,
  NotFoundException,
  ParseUUIDPipe,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import { BondCatalogService } from "./bond-catalog.service";
import {
  BondDataInconsistentError,
  BondDataNotFoundError,
} from "./bond-errors";
import { BondPriceService } from "./bond-price.service";
import { todayYMD } from "../common/date-utils";
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
    const moduleRef = await Test.createTestingModule({
      controllers: [BondsController],
      providers: [
        { provide: BondCatalogService, useValue: catalog },
        { provide: BondValuationService, useValue: valuation },
        { provide: BondPriceService, useValue: prices },
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
});
