import { EntityManager, ObjectLiteral, SelectQueryBuilder } from "typeorm";

import { UserPreference } from "../users/entities/user-preference.entity";
import {
  ParsedSearch,
  parseTransactionSearch,
  SearchFormats,
} from "./transaction-search-query.util";
import {
  buildTransactionSearchWhere,
  SearchClauseOptions,
} from "./transaction-search.util";

/**
 * The one door from a search string to a query (INV-SEARCH-001,
 * `docs/future-plans/advanced-search.md`). Every surface that takes a search
 * string reads it here: the user's number and date formats are loaded, the
 * string is parsed once, and the clause is applied with the caller's aliases,
 * grain and parameter prefix. Escaping happens inside the builder; callers
 * pass the raw string.
 *
 * The three steps are exported separately because the register parses once
 * and applies the same terms to several queries (the page, the target-page
 * lookup, the running-balance windows), which must read the string
 * identically.
 */

/** The user's number and date formats, which amounts and dates are read in. */
export async function loadSearchFormats(
  m: EntityManager,
  userId: string,
): Promise<SearchFormats> {
  const prefs = await m
    .getRepository(UserPreference)
    .findOne({ where: { userId } });
  return {
    numberFormat: prefs?.numberFormat,
    dateFormat: prefs?.dateFormat,
  };
}

/**
 * Parses `raw` in the user's formats. A blank or absent string is
 * `undefined`, which every apply step treats as "no search".
 */
export async function resolveTransactionSearch(
  m: EntityManager,
  userId: string,
  raw: string | undefined | null,
): Promise<ParsedSearch | undefined> {
  if (!raw || !raw.trim()) return undefined;
  return parseTransactionSearch(raw, await loadSearchFormats(m, userId));
}

/** Applies already-parsed terms to `qb` as one AND-ed condition. */
export function applyParsedSearch<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  parsed: ParsedSearch | undefined,
  options: SearchClauseOptions,
): void {
  if (!parsed) return;
  const clause = buildTransactionSearchWhere(parsed.terms, options);
  if (clause) qb.andWhere(clause.sql, clause.params);
}

/**
 * Loads, parses and applies in one call. Returns the parsed terms (the echo
 * of plan section 6), or `undefined` for a blank string.
 */
export async function applyTransactionSearch<T extends ObjectLiteral>(
  m: EntityManager,
  qb: SelectQueryBuilder<T>,
  raw: string | undefined | null,
  options: SearchClauseOptions & { userId: string },
): Promise<ParsedSearch | undefined> {
  const { userId, ...clauseOptions } = options;
  const parsed = await resolveTransactionSearch(m, userId, raw);
  applyParsedSearch(qb, parsed, clauseOptions);
  return parsed;
}
