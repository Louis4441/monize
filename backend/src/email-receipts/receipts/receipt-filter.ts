import { escapeLikePattern } from "../../transactions/transaction-search.util";
import type { EmailReceiptStatus } from "../entities/email-receipt.entity";

/**
 * The sender-domain predicate of the receipts page, written once: an email
 * matches a domain when its own (post forward-detection) `from_domain` is that
 * domain or one of its sub-domains, with `%`, `_` and `\` taken literally. The
 * list, the status counts, "process in bulk" and the bulk delete / ignore all
 * read it, so the number the page prints for a filter is the number a command on
 * that filter acts on.
 */

/** The two bind values of the domain predicate; both null without a domain. */
export interface ReceiptDomainParams {
  domain: string | null;
  domainLike: string | null;
}

/** A person's domain filter as the queries read it: trimmed, lower-case, `null` for none. */
export function receiptDomainParams(
  rawDomain: string | undefined | null,
): ReceiptDomainParams {
  const domain = rawDomain?.trim().toLowerCase() || null;
  return {
    domain,
    domainLike: domain === null ? null : `%.${escapeLikePattern(domain)}`,
  };
}

/**
 * The SQL of the predicate over `r.from_domain`. `domainIndex` and `likeIndex`
 * are the positions (`$n`) the two values of `receiptDomainParams` are bound at.
 */
export function receiptDomainClause(
  domainIndex: number,
  likeIndex: number,
): string {
  return `($${domainIndex}::varchar IS NULL
                   OR r.from_domain = $${domainIndex}::varchar
                   OR r.from_domain LIKE $${likeIndex}::varchar ESCAPE '\\')`;
}

/**
 * What a bulk command, its count, a reprocess and the approval listing select,
 * written once. Every field is optional; the fields combine with AND. The
 * excluded states and domains take emails out of what `status` and `domain` keep.
 */
export interface ReceiptSelectionFilter {
  status?: EmailReceiptStatus;
  domain?: string;
  /** States taken out of the selection. */
  excludeStatuses?: readonly EmailReceiptStatus[];
  /** Sender domains taken out, each with its sub-domains (the predicate of `domain`). */
  excludeDomains?: readonly string[];
  /** `YYYY-MM-DD`, inclusive, a UTC day on `received_at`. */
  receivedFrom?: string;
  receivedTo?: string;
}

/** How many bind values `receiptSelectionClause` uses. */
export const RECEIPT_SELECTION_PARAM_COUNT = 8;

/**
 * The selection as SQL over alias `r` (`email_receipts`) and the bind values it
 * reads, in order from `$firstParamIndex` (always `RECEIPT_SELECTION_PARAM_COUNT`
 * of them). Nothing of the filter is spliced into the text.
 */
export function receiptSelectionClause(
  filter: ReceiptSelectionFilter,
  firstParamIndex: number,
): { sql: string; params: unknown[] } {
  const { domain, domainLike } = receiptDomainParams(filter.domain);
  const excluded = [
    ...new Set(
      (filter.excludeDomains ?? [])
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d !== ""),
    ),
  ];
  const at = (offset: number): number => firstParamIndex + offset;
  const sql = `($${at(0)}::varchar IS NULL OR r.status = $${at(0)}::varchar)
            AND ${receiptDomainClause(at(1), at(2))}
            AND NOT (r.status = ANY($${at(3)}::varchar[]))
            AND NOT (r.from_domain = ANY($${at(4)}::varchar[])
                     OR EXISTS (SELECT 1
                                  FROM unnest($${at(5)}::varchar[]) AS ex(pattern)
                                 WHERE r.from_domain LIKE ex.pattern ESCAPE '\\'))
            AND ($${at(6)}::date IS NULL
                 OR r.received_at >= ($${at(6)}::date)::timestamp AT TIME ZONE 'UTC')
            AND ($${at(7)}::date IS NULL
                 OR r.received_at < (($${at(7)}::date) + 1)::timestamp AT TIME ZONE 'UTC')`;
  return {
    sql,
    params: [
      filter.status ?? null,
      domain,
      domainLike,
      [...(filter.excludeStatuses ?? [])],
      excluded,
      excluded.map((d) => `%.${escapeLikePattern(d)}`),
      filter.receivedFrom ?? null,
      filter.receivedTo ?? null,
    ],
  };
}
