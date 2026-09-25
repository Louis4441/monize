import { Test, TestingModule } from "@nestjs/testing";
import { QuoteProviderRegistry } from "./quote-provider.registry";
import { YahooFinanceService } from "../yahoo-finance.service";
import { MsnFinanceService } from "../msn-finance.service";
import { LseFinanceService } from "../lse-finance.service";
import { DeutscheBoerseFinanceService } from "../deutsche-boerse-finance.service";
import { Security } from "../entities/security.entity";

describe("QuoteProviderRegistry", () => {
  let registry: QuoteProviderRegistry;

  const yahooMock = { name: "yahoo" } as unknown as YahooFinanceService;
  const msnMock = { name: "msn" } as unknown as MsnFinanceService;
  const lseMock = { name: "lse" } as unknown as LseFinanceService;
  const dbgMock = {
    name: "deutsche_boerse",
  } as unknown as DeutscheBoerseFinanceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuoteProviderRegistry,
        { provide: YahooFinanceService, useValue: yahooMock },
        { provide: MsnFinanceService, useValue: msnMock },
        { provide: LseFinanceService, useValue: lseMock },
        { provide: DeutscheBoerseFinanceService, useValue: dbgMock },
      ],
    }).compile();
    registry = module.get(QuoteProviderRegistry);
  });

  it("getByName resolves every provider", () => {
    expect(registry.getByName("yahoo").name).toBe("yahoo");
    expect(registry.getByName("msn").name).toBe("msn");
    expect(registry.getByName("lse").name).toBe("lse");
    expect(registry.getByName("deutsche_boerse").name).toBe("deutsche_boerse");
  });

  it("resolveForSecurity honors the override and falls back to general providers only", () => {
    const security = { quoteProvider: "msn" } as Security;
    const ordered = registry.resolveForSecurity(security, "yahoo");
    // Exchange-specific providers are never a blanket fallback.
    expect(ordered.map((p) => p.name)).toEqual(["msn", "yahoo"]);
  });

  it("resolveForSecurity keeps general providers behind an exchange-specific primary", () => {
    const security = { quoteProvider: "lse" } as Security;
    const ordered = registry.resolveForSecurity(security, "yahoo");
    expect(ordered.map((p) => p.name)).toEqual(["lse", "yahoo", "msn"]);
  });

  it("resolveForSecurity does not add the other exchange provider as a fallback", () => {
    const security = { quoteProvider: "deutsche_boerse" } as Security;
    const ordered = registry.resolveForSecurity(security, "yahoo");
    expect(ordered.map((p) => p.name)).toEqual([
      "deutsche_boerse",
      "yahoo",
      "msn",
    ]);
  });

  it("resolveForSecurity falls back to user default when security has no override", () => {
    const security = { quoteProvider: null } as Security;
    const ordered = registry.resolveForSecurity(security, "msn");
    expect(ordered.map((p) => p.name)).toEqual(["msn", "yahoo"]);
  });

  it("resolveForSecurity falls back to yahoo when both security and user have no preference", () => {
    const security = { quoteProvider: null } as Security;
    const ordered = registry.resolveForSecurity(security, null);
    expect(ordered.map((p) => p.name)).toEqual(["yahoo", "msn"]);
  });

  it("listAll returns every provider", () => {
    expect(
      registry
        .listAll()
        .map((p) => p.name)
        .sort(),
    ).toEqual(["deutsche_boerse", "lse", "msn", "yahoo"]);
  });
});
