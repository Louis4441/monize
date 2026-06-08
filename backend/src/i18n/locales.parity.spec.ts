import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Structural parity between the English source catalogues and every translated
 * backend locale. A missing key would silently fall back to the inline English
 * `tr()` default, and a `{{ placeholder }}` that drifts from the source would
 * interpolate nothing -- both are guarded here for all current and future
 * locales under `locales/`.
 */

const localesDir = join(__dirname, "locales");

const TRANSLATED_LOCALES = readdirSync(localesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "en")
  .map((d) => d.name);

const enFiles = readdirSync(join(localesDir, "en")).filter((f) =>
  f.endsWith(".json"),
);

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function flatten(value: Json, prefix = ""): Record<string, Json> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).reduce<Record<string, Json>>(
      (acc, [k, v]) =>
        Object.assign(acc, flatten(v, prefix ? `${prefix}.${k}` : k)),
      {},
    );
  }
  return { [prefix]: value };
}

function load(locale: string, file: string): Record<string, Json> {
  return flatten(
    JSON.parse(readFileSync(join(localesDir, locale, file), "utf8")),
  );
}

function placeholders(value: string): string[] {
  return (value.match(/\{\{.*?\}\}/g) ?? []).sort();
}

describe.each(TRANSLATED_LOCALES)("backend locale '%s'", (locale) => {
  it("has the same catalogue files as en", () => {
    expect(
      readdirSync(join(localesDir, locale))
        .filter((f) => f.endsWith(".json"))
        .sort(),
    ).toEqual(enFiles.slice().sort());
  });

  describe.each(enFiles)("%s", (file) => {
    const en = load("en", file);
    const translated = load(locale, file);

    it("has identical key structure to en", () => {
      expect(Object.keys(translated).sort()).toEqual(Object.keys(en).sort());
    });

    it("preserves every {{ placeholder }} from en", () => {
      for (const [key, value] of Object.entries(en)) {
        if (typeof value !== "string") continue;
        const localeValue = translated[key];
        expect(typeof localeValue).toBe("string");
        expect(placeholders(localeValue as string)).toEqual(
          placeholders(value),
        );
      }
    });
  });
});
