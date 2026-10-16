import { escapeLikePattern } from "../../transactions/transaction-search.util";

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
