import {
  DEFAULT_MNY_IMPORT_OPTIONS,
  accountSelection,
  resolveImportOptions,
} from "./mny-import-options";

describe("mny import options", () => {
  describe("defaults", () => {
    it("never deletes existing data unless asked", () => {
      expect(DEFAULT_MNY_IMPORT_OPTIONS.wipeExistingData).toBe(false);
    });

    it("imports only referenced payees and categories", () => {
      expect(DEFAULT_MNY_IMPORT_OPTIONS.referencedOnlyPayees).toBe(true);
      expect(DEFAULT_MNY_IMPORT_OPTIONS.referencedOnlyCategories).toBe(true);
    });

    it("keeps closed accounts, prices and rates", () => {
      expect(DEFAULT_MNY_IMPORT_OPTIONS.importClosedAccounts).toBe(true);
      expect(DEFAULT_MNY_IMPORT_OPTIONS.importPrices).toBe(true);
      expect(DEFAULT_MNY_IMPORT_OPTIONS.importExchangeRates).toBe(true);
    });
  });

  describe("resolveImportOptions", () => {
    it("fills every field from the defaults for a null payload", () => {
      expect(resolveImportOptions(null)).toEqual(DEFAULT_MNY_IMPORT_OPTIONS);
      expect(resolveImportOptions(undefined)).toEqual(
        DEFAULT_MNY_IMPORT_OPTIONS,
      );
    });

    it("keeps the caller's values and defaults the rest", () => {
      const options = resolveImportOptions({ wipeExistingData: true });

      expect(options.wipeExistingData).toBe(true);
      expect(options.referencedOnlyPayees).toBe(true);
      expect(options.accounts).toEqual([]);
    });
  });

  describe("accountSelection", () => {
    it("includes an account the wizard did not mention", () => {
      expect(accountSelection(DEFAULT_MNY_IMPORT_OPTIONS, 42, false)).toEqual({
        include: true,
        currencyOverride: null,
      });
    });

    it("honours an explicit exclusion", () => {
      const options = resolveImportOptions({
        accounts: [{ handle: 42, include: false, currencyOverride: null }],
      });

      expect(accountSelection(options, 42, false).include).toBe(false);
    });

    it("honours a per-account currency override", () => {
      const options = resolveImportOptions({
        accounts: [{ handle: 7, include: true, currencyOverride: "CAD" }],
      });

      expect(accountSelection(options, 7, false)).toEqual({
        include: true,
        currencyOverride: "CAD",
      });
    });

    it("drops closed accounts when the closed-accounts option is off", () => {
      const options = resolveImportOptions({ importClosedAccounts: false });

      expect(accountSelection(options, 1, true).include).toBe(false);
      expect(accountSelection(options, 1, false).include).toBe(true);
    });

    it("lets an explicit tick override the closed-accounts option", () => {
      const options = resolveImportOptions({
        importClosedAccounts: false,
        accounts: [{ handle: 1, include: true, currencyOverride: null }],
      });

      expect(accountSelection(options, 1, true).include).toBe(true);
    });

    it("treats a handleless account as unmentioned", () => {
      const options = resolveImportOptions({
        accounts: [{ handle: 1, include: false, currencyOverride: null }],
      });

      expect(accountSelection(options, null, false).include).toBe(true);
    });
  });
});
