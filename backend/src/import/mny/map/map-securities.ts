import { MnyLot, MnySecurity, MnyTransaction } from "../model/mny-rows";
import { MappedSecurities, MappedSecurity } from "../model/mny-import-model";
import { isCurrencyPseudoSecurity } from "../model/mny-model";
import { MnyWarning } from "../model/mny-warnings";

/**
 * `SEC` mapped onto Monize securities.
 *
 * Three PR #192 defects are fixed here, and each one loses data silently when it
 * is not:
 *
 * - **Currency pseudo-securities never become securities**, recognised by the
 *   `/GBPUS` symbol shape alone (design 6.3). Not by `SEC.sct`: the code that
 *   test used to carry, 4, turned out to be Money's money-market fund -- see
 *   `isCurrencyPseudoSecurity`.
 * - **Two securities never collapse into one.** `securities` is unique on
 *   `(user_id, symbol)`; PR #192 wrote `ON CONFLICT ... DO UPDATE`, which merged
 *   two distinct funds that happened to share a ticker. Here the second one is
 *   suffixed (`VOO-2`) and warned about.
 * - **An empty symbol gets a generated placeholder**, not `name.slice(0, 20)`,
 *   which collided for similarly-named funds. Placeholders carry
 *   `skipPriceUpdates`, matching what the QIF importer does for the securities
 *   it auto-creates.
 *
 * **A security the user never traded or held is not imported.** Money's `SEC`
 * doubles as its watch list and its index-quote store, and the two are not
 * distinguishable by `sct` -- the maintainer's file has the Dow, the NASDAQ,
 * the DAX, the FTSE, the Hang Seng, the Nikkei, the TSX and the Straits Times
 * sitting under the same code as two ETFs actually owned. What does separate
 * them is activity: 31 of 98 securities appear in no `TRN` row and no `LOT`,
 * and they carry 17,025 of the file's 69,076 prices. Monize has nowhere to show
 * an index, and a security with no position is a row the user has to clean up,
 * so the whole quarter is left behind. `dedupePrices` keys off the imported
 * securities, so their price history drops out with them.
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
 * Removes the market Money qualifies a symbol with: `US:VTI` is the ticker
 * `VTI` held on a US market, and `$US:INDU` is an index, where the leading `$`
 * is Money's own index marker rather than part of the prefix.
 *
 * The qualifier is Money's bookkeeping, not the ticker. Left on, it costs twice:
 * `writeSecurities` matches existing holdings by symbol, so `US:VTI` creates a
 * second security beside the user's own `VTI` instead of reusing it, and every
 * price lookup for the imported one asks the quote providers for a symbol that
 * does not exist.
 *
 * Only the market segment goes, so an index stays an index (`$US:INDU` ->
 * `$INDU`) and a symbol Money never qualified is untouched. The qualifier is an
 * ISO country code, hence exactly two letters -- `$OSPTX` keeps its shape and a
 * ticker that merely contains a colon is not a market prefix.
 */
export function stripMarketPrefix(symbol: string): string {
  const stripped = symbol.replace(/^(\$?)[A-Za-z]{2}:/, "$1");
  // "US:" with nothing after it is not a ticker worth preferring over what
  // Money actually stored.
  return stripped === "" || stripped === "$" ? symbol : stripped;
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
  /**
   * Handles the user actually traded or held -- every `TRN.hsec` and `LOT.hsec`
   * in the file. Securities outside it are Money's watch list, not holdings.
   */
  readonly activeHandles: ReadonlySet<number>;
}

/**
 * The securities the file shows real activity for: transacted (`TRN.hsec`) or
 * still held as a lot (`LOT.hsec`). This is the `activeHandles` every caller
 * should pass -- `LOT` as well as `TRN`, so a position carried in without a
 * transaction of its own still counts as held.
 */
export function tradedSecurityHandles(
  transactions: readonly MnyTransaction[],
  lots: readonly MnyLot[],
): ReadonlySet<number> {
  const handles = new Set<number>();
  for (const row of transactions) {
    if (row.security !== null) {
      handles.add(row.security);
    }
  }
  for (const lot of lots) {
    if (lot.security !== null) {
      handles.add(lot.security);
    }
  }
  return handles;
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
    if (isCurrencyPseudoSecurity(moneySymbol)) {
      // Money keeps every currency in SEC too. Importing them produces
      // securities the user never held.
      skipped += 1;
      continue;
    }

    if (!input.activeHandles.has(row.handle)) {
      // Never traded and never held: a watch-list entry or a market index Money
      // was tracking quotes for. See the note above `mapSecurities`.
      skipped += 1;
      continue;
    }

    const name = row.name.trim();
    if (name === "" && moneySymbol === "") {
      skipped += 1;
      continue;
    }

    const generated = moneySymbol === "";
    const requested = generated
      ? placeholderSymbol(name)
      : stripMarketPrefix(moneySymbol);
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
