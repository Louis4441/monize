import { EntityManager } from "typeorm";
import { seriesOnSaleSql } from "../bonds/bond-series-resolver";

/**
 * Why a security cannot be linked to a bond program (the engine prices a linked
 * security and nothing else does). One definition for the write that links
 * (`SecuritiesService.update`/`create`), the preview of the AI assistant and MCP
 * `update_security`, and the undo of a security edit, so the three cannot
 * disagree about what a valid link is
 * (`docs/specs/bond-program-securities.md` section 2.2).
 */
export type BondLinkProblem =
  | { readonly code: "PROGRAM_NOT_FOUND" }
  /** Only a security of type BOND can be linked. */
  | { readonly code: "NOT_BOND_TYPE" }
  /** `instrumentCurrency` is the program's currency (the name predates programs). */
  | { readonly code: "CURRENCY_MISMATCH"; readonly instrumentCurrency: string };

/** The security type a link requires. */
export const BOND_SECURITY_TYPE = "BOND";

/**
 * The first problem with linking a security of this type and currency to the
 * program, or null when the link is valid: the program exists, the security is
 * of type BOND, and it is recorded in the program's currency (INV-PRICE-001 -- a
 * stored price is in the currency the security is recorded in, and the engine
 * prices in the program's).
 */
export async function findBondLinkProblem(
  m: EntityManager,
  link: {
    readonly bondProgramId: string;
    readonly currencyCode: string;
    readonly securityType: string | null | undefined;
  },
): Promise<BondLinkProblem | null> {
  const rows: Array<{ currency_code: string }> = await m.query(
    `SELECT currency_code FROM bond_programs WHERE id = $1`,
    [link.bondProgramId],
  );
  if (rows.length === 0) return { code: "PROGRAM_NOT_FOUND" };
  if (link.securityType !== BOND_SECURITY_TYPE)
    return { code: "NOT_BOND_TYPE" };
  const programCurrency = rows[0].currency_code;
  return programCurrency === link.currencyCode
    ? null
    : { code: "CURRENCY_MISMATCH", instrumentCurrency: programCurrency };
}

/**
 * A share-moving trade price within this multiple of the face value per bond is
 * a price per bond (the exchange price of a bond is close to par).
 */
export const BOND_UNIT_PRICE_BAND = { min: "0.5", max: "2" } as const;

/**
 * True when the security has a trade whose per-unit price is not within
 * [0.5, 2] x the face value of the series it will be read as, which means its
 * quantities are not numbers of bonds (a legacy security recording currency
 * units, or one unit per package): the lot derivation reads a quantity as a
 * count of bonds, so the link would publish a figure off by a factor of the face
 * value. A row is read as its stored series when that is in the NEW program;
 * otherwise (no stored series, or one of another program, which the link
 * clears) as the series of the new program on sale on its date
 * (`seriesOnSaleSql`, the inference a write applies), and when none is on sale
 * that day as the program's newest series (the greatest sale window start): a
 * row is never skipped for lack of a series. Rows with no price (ADD_SHARES, a
 * transfer) say nothing and are not read; VOID rows recorded nothing.
 */
export async function hasQuantitiesThatAreNotBonds(
  m: EntityManager,
  userId: string,
  securityId: string,
  bondProgramId: string,
): Promise<boolean> {
  const onSale = seriesOnSaleSql(
    "$3",
    "TO_CHAR(t.transaction_date, 'YYYY-MM-DD')",
  );
  const rows: unknown[] = await m.query(
    `SELECT 1
       FROM (
         SELECT t.*
           FROM investment_transactions t
          WHERE t.security_id = $1 AND t.user_id = $2
            AND t.status != 'VOID'
            AND t.action IN ('BUY', 'SELL', 'REINVEST', 'REINVEST_INTEREST',
                             'REINVEST_CAPITAL_GAIN_SHORT', 'REINVEST_CAPITAL_GAIN_LONG')
            AND t.price IS NOT NULL AND t.price > 0
       ) t
      CROSS JOIN LATERAL (
        SELECT i.id
          FROM bond_instruments i
         WHERE i.bond_program_id = $3::uuid
           AND (
             i.id = t.bond_instrument_id
             OR (
               NOT EXISTS (SELECT 1 FROM bond_instruments o
                            WHERE o.id = t.bond_instrument_id
                              AND o.bond_program_id = $3::uuid)
               AND (
                 i.id IN (${onSale})
                 OR (
                   NOT EXISTS (${onSale})
                   AND i.id = (
                     SELECT n.id
                       FROM bond_instruments n
                      CROSS JOIN LATERAL (
                        SELECT v.terms
                          FROM bond_terms_versions v
                         WHERE v.bond_instrument_id = n.id
                         ORDER BY v.version DESC
                         LIMIT 1
                      ) nv
                      WHERE n.bond_program_id = $3::uuid
                      ORDER BY (nv.terms -> 'saleWindow' ->> 'from') DESC NULLS LAST,
                               n.series_code DESC
                      LIMIT 1
                   )
                 )
               )
             )
           )
      ) r
      CROSS JOIN LATERAL (
        SELECT (terms -> 'instrument' ->> 'faceValue')::numeric AS face
          FROM bond_terms_versions
         WHERE bond_instrument_id = r.id
         ORDER BY version DESC
         LIMIT 1
      ) f
      WHERE f.face IS NOT NULL AND f.face > 0
        AND (t.price < f.face * ${BOND_UNIT_PRICE_BAND.min}::numeric
             OR t.price > f.face * ${BOND_UNIT_PRICE_BAND.max}::numeric)
      LIMIT 1`,
    [securityId, userId, bondProgramId],
  );
  return rows.length > 0;
}
