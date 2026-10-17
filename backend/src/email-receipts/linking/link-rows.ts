import type { EntityManager } from "typeorm";
import type {
  ReceiptLinkOutcome,
  ReceiptLinkReport,
} from "../parsing/receipt-parser.types";

const UNITS_PER_MONEY = 10000;

/** One `email_receipt_links` row to write; `partAmount` in 1/10000 units. */
export interface LinkRowInput {
  partIndex: number;
  link: string | null;
  partAmount: number;
  /** Set only for a `joined` or `scaled` part. */
  componentReceiptId: string | null;
  outcome: ReceiptLinkOutcome;
}

/** The link rows of a joined settlement's reports (spec 5): the component only for `joined` and `scaled`. */
export function linkRowsOf(
  reports: readonly ReceiptLinkReport[],
): LinkRowInput[] {
  return reports.map((report) => ({
    partIndex: report.partIndex,
    link: report.link,
    partAmount: report.partAmount,
    componentReceiptId:
      report.outcome === "joined" || report.outcome === "scaled"
        ? report.componentReceiptId
        : null,
    outcome: report.outcome,
  }));
}

/** Integer units as an exact decimal string (`12345` -> `1.2345`): no float is accumulated. */
export function unitsToDecimal(units: number): string {
  const negative = units < 0;
  const abs = Math.abs(Math.round(units));
  const whole = Math.floor(abs / UNITS_PER_MONEY);
  const fraction = String(abs % UNITS_PER_MONEY).padStart(4, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Replace the rows of a settlement (spec 5): delete, then one multi-row insert.
 * `rows` undefined or empty leaves the settlement with none, which is what an
 * outcome that never reached the join stores.
 */
export async function replaceLinkRows(
  m: EntityManager,
  userId: string,
  settlementReceiptId: string,
  rows: readonly LinkRowInput[] | undefined,
): Promise<void> {
  await m.query(
    `DELETE FROM email_receipt_links
      WHERE settlement_receipt_id = $1 AND user_id = $2`,
    [settlementReceiptId, userId],
  );
  if (!rows || rows.length === 0) return;
  const values: unknown[] = [userId, settlementReceiptId];
  const tuples = rows.map((row) => {
    const base = values.length;
    values.push(
      row.partIndex,
      row.link,
      unitsToDecimal(row.partAmount),
      row.componentReceiptId,
      row.outcome,
    );
    return `($1, $2, $${base + 1}, $${base + 2}, $${base + 3}::numeric, $${base + 4}, $${base + 5})`;
  });
  await m.query(
    `INSERT INTO email_receipt_links
       (user_id, settlement_receipt_id, part_index, link_value, part_amount,
        component_receipt_id, outcome)
     VALUES ${tuples.join(", ")}`,
    values,
  );
}
