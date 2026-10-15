import type { GlobCaptures } from "../../transaction-rules/rule-glob-capture";
import { findField, readAmount } from "./parse-receipt";
import { isStrictReceiptAmount, parseReceiptAmount } from "./receipt-amount";
import { normalizeLine } from "./receipt-lines";
import { matchReceiptPattern } from "./receipt-glob";
import {
  MAX_TRADE_QUANTITY_DECIMALS,
  type ParsedTrade,
  type ParsedTradeAction,
  type ParsedTradeReason,
  type ReceiptFieldEntry,
  type ReceiptTradeDefinition,
  type ReceiptTradeTrace,
  type ReceiptTraceHit,
} from "./receipt-parser.types";

/**
 * The trade reader (design "Trade confirmations"): the lines of one brokerage
 * "order filled" email in, one {@link ParsedTrade} out. Pure: no database, no
 * clock, no regular expression built from the profile. It reuses the receipt
 * reader's field machinery (`findField`: entries in array order, line patterns
 * and labelled entries), so a trade profile reads exactly like a receipt one.
 *
 * Arithmetic is integer: money is 1/10000 units, a share count is held as an
 * integer of 1e-8 shares in a BigInt while it is multiplied by a price, so a
 * fractional share (75.9878) is never a float in a comparison.
 */

const MONEY_UNITS = 10_000;
const QUANTITY_UNITS = 100_000_000n;
const MAX_QUANTITY_TEXT = 24;
const ONE_CENT_UNITS = 100n;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const isDigits = (text: string): boolean =>
  text !== "" && [...text].every((ch) => ch >= "0" && ch <= "9");

/**
 * A share count: digits with an optional `.` and up to 8 decimals; a comma is a
 * thousands separator. Anything else (a sign, an exponent, text, a second
 * point) is null. Returned as the exact integer of 1e-8 shares and as a number.
 */
export function parseTradeQuantity(
  text: string,
): { units: bigint; value: number } | null {
  const trimmed = text.trim().replace(/,/g, "");
  if (trimmed === "" || trimmed.length > MAX_QUANTITY_TEXT) return null;
  const [whole, fraction = "", ...rest] = trimmed.split(".");
  if (rest.length > 0) return null;
  if (!isDigits(whole) || (fraction !== "" && !isDigits(fraction))) {
    return null;
  }
  if (fraction.length > MAX_TRADE_QUANTITY_DECIMALS) return null;
  if (whole.length > 12) return null;
  const units =
    BigInt(whole) * QUANTITY_UNITS +
    BigInt(fraction.padEnd(MAX_TRADE_QUANTITY_DECIMALS, "0"));
  if (units === 0n) return null;
  return { units, value: Number(trimmed) };
}

/** Whether the text names a buy or a sell (the first word wins); null when it names neither or both. */
export function parseTradeAction(text: string): ParsedTradeAction | null {
  const words = text.toLowerCase().split(/[^a-z]+/);
  const buy = words.includes("buy") || words.includes("bought");
  const sell = words.includes("sell") || words.includes("sold");
  if (buy === sell) return null;
  return buy ? "BUY" : "SELL";
}

/**
 * The day in a trade's date text: `YYYY-MM-DD`, or an English month name with a
 * day and a year ("October 15, 2026 12:04 EDT"). The time and the zone are
 * ignored on purpose: the text states the broker's own local day, which is the
 * day the trade is dated. Null when no real calendar day is found.
 */
export function parseTradeDate(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((t) => t !== "");
  for (const token of tokens) {
    const parts = token.split("-");
    if (
      parts.length === 3 &&
      parts[0].length === 4 &&
      parts[1].length === 2 &&
      parts[2].length === 2 &&
      parts.every(isDigits)
    ) {
      return validDay(Number(parts[0]), Number(parts[1]), Number(parts[2]));
    }
  }
  for (let i = 0; i + 2 < tokens.length; i++) {
    const month = MONTHS[tokens[i].replace(/\.$/, "")];
    const day = tokens[i + 1].replace(/(st|nd|rd|th)$/, "");
    const year = tokens[i + 2];
    if (month && isDigits(day) && year.length === 4 && isDigits(year)) {
      return validDay(Number(year), month, Number(day));
    }
  }
  return null;
}

function validDay(year: number, month: number, day: number): string | null {
  if (year < 1990 || year > 2200 || month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > last) return null;
  const pad = (n: number, width: number): string =>
    String(n).padStart(width, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** The decimals a price was written with ("26.32" is 2); a text with no point has none. */
function priceDecimals(text: string): number {
  const cleaned = text.trim().replace(/[^0-9.]/g, "");
  const at = cleaned.lastIndexOf(".");
  return at < 0 ? 0 : Math.min(4, cleaned.length - at - 1);
}

/**
 * Whether quantity times price agrees with the executed total. A price written
 * with `d` decimals is within half a unit of its last place, so the product may
 * be off by `quantity * 0.5 * 10^-d`, plus one cent for the total's own
 * rounding. Commission is in the total of a buy and out of a sell's proceeds.
 */
export function tradeIsConsistent(input: {
  action: ParsedTradeAction;
  quantityUnits: bigint;
  priceUnits: number;
  priceDecimals: number;
  totalUnits: number;
  commissionUnits: number;
}): boolean {
  const gross =
    input.action === "BUY"
      ? input.totalUnits - input.commissionUnits
      : input.totalUnits + input.commissionUnits;
  if (gross < 0) return false;
  // Both sides at 1e-12 of a currency unit: quantity (1e-8) * price (1e-4).
  const product = input.quantityUnits * BigInt(input.priceUnits);
  const expected = BigInt(gross) * QUANTITY_UNITS;
  const diff = product > expected ? product - expected : expected - product;
  const halfLastPlace = 10n ** BigInt(4 - input.priceDecimals) / 2n;
  const tolerance =
    input.quantityUnits * (halfLastPlace === 0n ? 1n : halfLastPlace) +
    ONE_CENT_UNITS * QUANTITY_UNITS;
  return diff <= tolerance;
}

const hasCapture =
  (name: string) =>
  (captures: GlobCaptures): boolean =>
    (captures[name] ?? "").trim() !== "";

/** The first non-empty capture `name` a field reads, with what read it. */
function readText(
  entries: readonly ReceiptFieldEntry[] | undefined,
  lines: readonly string[],
  name: string,
  accept: (value: string) => boolean = () => true,
): { value: string; hit: ReceiptTraceHit } | null {
  const found = findField(
    entries,
    lines,
    (captures) => hasCapture(name)(captures) && accept(captures[name].trim()),
  );
  return found === null
    ? null
    : { value: found.captures[name].trim(), hit: found.hit };
}

/** The account a trade is for: the first rule whose glob matches the account text, else the default. */
export function resolveTradeAccountId(
  definition: Pick<ReceiptTradeDefinition, "accountRules" | "defaultAccountId">,
  accountText: string | null,
): string | null {
  if (accountText !== null) {
    const line = normalizeLine(accountText);
    for (const rule of definition.accountRules ?? []) {
      if (matchReceiptPattern(rule.match, line, () => true) !== null) {
        return rule.accountId;
      }
    }
  }
  return definition.defaultAccountId ?? null;
}

export interface TracedTrade {
  trade: ParsedTrade;
  trace: ReceiptTradeTrace;
}

/** Read one email's lines with a profile's `trade` section. */
export function parseTradeLinesTraced(
  definition: ReceiptTradeDefinition,
  lines: readonly string[],
): TracedTrade {
  const action = readText(definition.action, lines, "action", (v) => {
    return parseTradeAction(v) !== null;
  });
  const symbol = readText(definition.symbol, lines, "symbol");
  const quantityRead = readText(
    definition.quantity,
    lines,
    "quantity",
    (v) => parseTradeQuantity(v) !== null,
  );
  const total = readAmount(definition.total, lines);
  // The price keeps the text it was written in: its decimals bound the rounding
  // the cross-check allows.
  const priceFound = findField(
    definition.price,
    lines,
    (captures) =>
      captures.amount !== undefined && isStrictReceiptAmount(captures.amount),
  );
  const priceUnits = priceFound
    ? parseReceiptAmount(priceFound.captures.amount)
    : null;
  const price =
    priceFound && priceUnits !== null
      ? { value: priceUnits, hit: priceFound.hit }
      : null;
  const commission = readAmount(definition.commission, lines);
  const dateRead = readText(
    definition.date,
    lines,
    "date",
    (v) => parseTradeDate(v) !== null,
  );
  const accountRead = readText(definition.account, lines, "account");

  const quantity = quantityRead ? parseTradeQuantity(quantityRead.value) : null;
  const accountText = accountRead?.value ?? null;
  const accountId = resolveTradeAccountId(definition, accountText);
  const actionValue = action ? parseTradeAction(action.value) : null;
  let reason: ParsedTradeReason | null = null;
  if (actionValue === null) reason = "trade_no_action";
  else if (symbol === null) reason = "trade_no_symbol";
  else if (quantity === null) reason = "trade_no_quantity";
  else if (total === null && price === null) reason = "trade_no_amount";
  else if (accountId === null) reason = "trade_no_account";

  let consistent: boolean | null = null;
  if (
    reason === null &&
    actionValue !== null &&
    quantity !== null &&
    total !== null &&
    price !== null
  ) {
    consistent = tradeIsConsistent({
      action: actionValue,
      quantityUnits: quantity.units,
      priceUnits: price.value,
      priceDecimals: priceDecimals(priceFound?.captures.amount ?? ""),
      totalUnits: total.value,
      commissionUnits: commission?.value ?? 0,
    });
  }

  const trade: ParsedTrade = {
    action: actionValue,
    symbol: symbol?.value ?? null,
    quantity: quantity?.value ?? null,
    total: total?.value ?? null,
    price: price?.value ?? null,
    commission: commission?.value ?? null,
    date: dateRead ? parseTradeDate(dateRead.value) : null,
    accountText,
    accountId,
    complete: reason === null,
    consistent,
    reason,
  };
  return {
    trade,
    trace: {
      action: action?.hit ?? null,
      symbol: symbol?.hit ?? null,
      quantity: quantityRead?.hit ?? null,
      total: total?.hit ?? null,
      price: price?.hit ?? null,
      commission: commission?.hit ?? null,
      date: dateRead?.hit ?? null,
      account: accountRead?.hit ?? null,
    },
  };
}

export function parseTradeLines(
  definition: ReceiptTradeDefinition,
  lines: readonly string[],
): ParsedTrade {
  return parseTradeLinesTraced(definition, lines).trade;
}

/** The executed total as a decimal for the proposal: 1/10000 units to a number with at most 4 decimals. */
export function tradeUnitsToAmount(units: number): number {
  return units / MONEY_UNITS;
}
