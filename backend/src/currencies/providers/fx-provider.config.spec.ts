import {
  DEFAULT_FX_PROVIDERS,
  FxProviderConfigError,
  resolveFxProviders,
} from "./fx-provider.config";
import { FX_PROVIDER_NAMES } from "./fx-provider.interface";

describe("resolveFxProviders", () => {
  it("answers the default list when FX_PROVIDERS is unset", () => {
    expect(resolveFxProviders(undefined)).toEqual([...DEFAULT_FX_PROVIDERS]);
    expect(resolveFxProviders(null)).toEqual([...DEFAULT_FX_PROVIDERS]);
  });

  it("answers the default list when FX_PROVIDERS is empty or only separators", () => {
    expect(resolveFxProviders("")).toEqual([...DEFAULT_FX_PROVIDERS]);
    expect(resolveFxProviders("   ")).toEqual([...DEFAULT_FX_PROVIDERS]);
    expect(resolveFxProviders(" , ,")).toEqual([...DEFAULT_FX_PROVIDERS]);
  });

  it("answers a copy of the default, so a caller cannot edit the constant", () => {
    const resolved = resolveFxProviders(undefined);
    expect(resolved).not.toBe(DEFAULT_FX_PROVIDERS);
  });

  it("every default name is a valid provider name", () => {
    for (const name of DEFAULT_FX_PROVIDERS) {
      expect(FX_PROVIDER_NAMES).toContain(name);
    }
  });

  it("trims and lower-cases each token", () => {
    expect(resolveFxProviders(" Yahoo ")).toEqual(["yahoo"]);
    expect(resolveFxProviders("YAHOO")).toEqual(["yahoo"]);
  });

  it("drops a repeated name, keeping its first position, and ignores blank tokens", () => {
    expect(resolveFxProviders("yahoo, ,YAHOO,yahoo")).toEqual(["yahoo"]);
  });

  it("refuses an unknown name, naming the token and the valid names", () => {
    let caught: unknown;
    try {
      resolveFxProviders("yahoo,yahooo");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FxProviderConfigError);
    const error = caught as FxProviderConfigError;
    expect(error.token).toBe("yahooo");
    expect(error.validNames).toEqual(FX_PROVIDER_NAMES);
    expect(error.message).toContain('"yahooo"');
    expect(error.message).toContain("FX_PROVIDERS");
    for (const name of FX_PROVIDER_NAMES) {
      expect(error.message).toContain(name);
    }
  });

  it("refuses rather than skipping: a valid name beside the bad one does not rescue the list", () => {
    expect(() => resolveFxProviders("nope,yahoo")).toThrow(
      FxProviderConfigError,
    );
  });
});
