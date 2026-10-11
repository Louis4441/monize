import { EntityManager } from "typeorm";

/**
 * Why a security cannot be linked to a bond instrument (the engine prices a
 * linked security and nothing else does). One definition for the write that
 * links (`SecuritiesService.update`/`create`), the preview of the AI assistant
 * and MCP `update_security`, and the undo of a security edit, so the three
 * cannot disagree about what a valid link is.
 */
export type BondLinkProblem =
  | { readonly code: "INSTRUMENT_NOT_FOUND" }
  /** Only a security of type BOND can be linked. */
  | { readonly code: "NOT_BOND_TYPE" }
  | { readonly code: "CURRENCY_MISMATCH"; readonly instrumentCurrency: string };

/** The security type a link requires. */
export const BOND_SECURITY_TYPE = "BOND";

/**
 * The first problem with linking a security of this type and currency to the
 * instrument, or null when the link is valid: the instrument exists, the
 * security is of type BOND, and it is recorded in the instrument's currency
 * (INV-PRICE-001 -- a stored price is in the currency the security is recorded
 * in, and the engine prices in the instrument's).
 */
export async function findBondLinkProblem(
  m: EntityManager,
  link: {
    readonly bondInstrumentId: string;
    readonly currencyCode: string;
    readonly securityType: string | null | undefined;
  },
): Promise<BondLinkProblem | null> {
  const rows: Array<{ currency_code: string }> = await m.query(
    `SELECT currency_code FROM bond_instruments WHERE id = $1`,
    [link.bondInstrumentId],
  );
  if (rows.length === 0) return { code: "INSTRUMENT_NOT_FOUND" };
  if (link.securityType !== BOND_SECURITY_TYPE)
    return { code: "NOT_BOND_TYPE" };
  const instrumentCurrency = rows[0].currency_code;
  return instrumentCurrency === link.currencyCode
    ? null
    : { code: "CURRENCY_MISMATCH", instrumentCurrency };
}

/**
 * A share-moving trade price within this multiple of the face value per bond is
 * a price per bond (the exchange price of a bond is close to par).
 */
export const BOND_UNIT_PRICE_BAND = { min: "0.5", max: "2" } as const;

/**
 * True when the security has a trade whose per-unit price is not within
 * [0.5, 2] x the instrument's face value, which means its quantities are not
 * numbers of bonds (a legacy security recording currency units, or one unit per
 * package): the lot derivation reads a quantity as a count of bonds, so the
 * link would publish a figure off by a factor of the face value. Rows with no
 * price (ADD_SHARES, a transfer) say nothing and are not read; VOID rows
 * recorded nothing.
 */
export async function hasQuantitiesThatAreNotBonds(
  m: EntityManager,
  userId: string,
  securityId: string,
  bondInstrumentId: string,
): Promise<boolean> {
  const rows: unknown[] = await m.query(
    `SELECT 1
       FROM investment_transactions t
       CROSS JOIN (
         SELECT (terms -> 'instrument' ->> 'faceValue')::numeric AS face
           FROM bond_terms_versions
          WHERE bond_instrument_id = $3
          ORDER BY version DESC
          LIMIT 1
       ) f
      WHERE t.security_id = $1 AND t.user_id = $2
        AND t.status != 'VOID'
        AND t.action IN ('BUY', 'SELL', 'REINVEST', 'REINVEST_INTEREST',
                         'REINVEST_CAPITAL_GAIN_SHORT', 'REINVEST_CAPITAL_GAIN_LONG')
        AND t.price IS NOT NULL AND t.price > 0
        AND f.face IS NOT NULL AND f.face > 0
        AND (t.price < f.face * ${BOND_UNIT_PRICE_BAND.min}::numeric
             OR t.price > f.face * ${BOND_UNIT_PRICE_BAND.max}::numeric)
      LIMIT 1`,
    [securityId, userId, bondInstrumentId],
  );
  return rows.length > 0;
}
