import { MnySecurity } from "../model/mny-rows";
import { MappedSecurities, MappedSecurity } from "../model/mny-import-model";
import { isCurrencyPseudoSecurity } from "../model/mny-model";
import { MnyWarning } from "../model/mny-warnings";

/**
 * `SEC` mapped onto Monize securities.
 *
 * Three PR #192 defects are fixed here, and each one loses data silently when it
 * is not:
 *
 * - **Currency pseudo-securities never become securities.** Money stores every
 *   currency in `SEC` as well. The `sct` code for them is not stable across
 *   releases, so `isCurrencyPseudoSecurity` also tests the `/GBPUS` symbol
 *   shape (design 6.3).
 * - **Two securities never collapse into one.** `securities` is unique on
 *   `(user_id, symbol)`; PR #192 wrote `ON CONFLICT ... DO UPDATE`, which merged
 *   two distinct funds that happened to share a ticker. Here the second one is
 *   suffixed (`VOO-2`) and warned about.
 * - **An empty symbol gets a generated placeholder**, not `name.slice(0, 20)`,
 *   which collided for similarly-named funds. Placeholders carry
 *   `skipPriceUpdates`, matching what the QIF importer does for the securities
 *   it auto-creates.
 *
 * `SEC.sct` is deliberately **not** mapped onto Monize's `securityType`: the
 * same Amex index securities are `sct` 6 in Money 2001/2002 and 7 in Money Plus,
 * so any mapping would mislabel some file. The column stays null and the user
 * can set it.
 */

/** `securities.symbol` is `varchar(20)`. */
export const MAX_SECURITY_SYMBOL_LENGTH = 20;

/** Room for the longest suffix a collision realistically needs. */
const COLLISION_SUFFIX_RESERVE = 3;

/**
 * A placeholder symbol for a security Money recorded without one, in the shape
 * the QIF importer already uses: the name's initials, or its first letters when
 * that is too short, marked with a trailing `*` so it is visibly not a ticker.
 */
export function placeholderSymbol(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = words
    .map((word) => word.charAt(0).toUpperCase())
    .join("")
    .replace(/[^A-Z0-9]/g, "");

  const base =
    initials.length >= 2
      ? initials
      : name
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "")
          .slice(0, 4);

  return `${(base || "SEC").slice(0, 9)}*`;
}

/**
 * Makes a symbol unique within the import, staying inside the column width.
 * The base is trimmed back before suffixing so `-2` never pushes the result
 * over the limit and truncates two distinct securities back onto each other.
 */
function uniqueSymbol(
  symbol: string,
  taken: Set<string>,
): { symbol: string; collided: boolean } {
  const base = symbol.slice(0, MAX_SECURITY_SYMBOL_LENGTH);
  if (!taken.has(base.toUpperCase())) {
    taken.add(base.toUpperCase());
    return { symbol: base, collided: false };
  }

  const stem = base.slice(
    0,
    MAX_SECURITY_SYMBOL_LENGTH - COLLISION_SUFFIX_RESERVE,
  );
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem}-${suffix}`;
    if (!taken.has(candidate.toUpperCase())) {
      taken.add(candidate.toUpperCase());
      return { symbol: candidate, collided: true };
    }
  }
}

export interface MapSecuritiesInput {
  readonly securities: readonly MnySecurity[];
  /** `CRNC.hcrnc` -> ISO code, from `currencyCodesByHandle`. */
  readonly currencyByHandle: ReadonlyMap<number, string>;
  /** Used when a security names no currency, or one the file does not define. */
  readonly baseCurrency: string;
}

export function mapSecurities(input: MapSecuritiesInput): MappedSecurities {
  const warnings: MnyWarning[] = [];
  const taken = new Set<string>();
  const securities: MappedSecurity[] = [];
  const byHandle = new Map<number, MappedSecurity>();
  let skipped = 0;

  for (const row of input.securities) {
    if (row.handle === null) {
      skipped += 1;
      continue;
    }

    const moneySymbol = row.symbol.trim();
    if (isCurrencyPseudoSecurity(row.securityType, moneySymbol)) {
      // Money keeps every currency in SEC too. Importing them produces
      // securities the user never held.
      skipped += 1;
      continue;
    }

    const name = row.name.trim();
    if (name === "" && moneySymbol === "") {
      skipped += 1;
      continue;
    }

    const generated = moneySymbol === "";
    const requested = generated ? placeholderSymbol(name) : moneySymbol;
    const { symbol, collided } = uniqueSymbol(requested, taken);

    if (generated) {
      warnings.push({
        code: "generatedSecuritySymbol",
        subject: name,
        detail: symbol,
      });
    }
    if (collided) {
      warnings.push({
        code: "duplicateSecuritySymbol",
        subject: requested,
        detail: symbol,
      });
    }

    const mapped: MappedSecurity = {
      handle: row.handle,
      symbol,
      moneySymbol,
      name: name === "" ? symbol : name,
      currencyCode: securityCurrency(row, input, warnings, name || symbol),
      skipPriceUpdates: generated,
    };

    securities.push(mapped);
    byHandle.set(row.handle, mapped);
  }

  return { securities, byHandle, skipped, warnings };
}

function securityCurrency(
  row: MnySecurity,
  input: MapSecuritiesInput,
  warnings: MnyWarning[],
  subject: string,
): string {
  if (row.currency === null) {
    return input.baseCurrency;
  }
  const code = input.currencyByHandle.get(row.currency);
  if (!code) {
    warnings.push({
      code: "unknownCurrency",
      subject,
      detail: `hcrnc=${row.currency}`,
    });
    return input.baseCurrency;
  }
  return code;
}
