import { MnyDatabase } from "../msisam/open-mny";
import { MnyBillData, readBillData } from "./read-bills";
import { MnyInvestmentData, readInvestmentData } from "./read-investments";
import { MnyReferenceData, readReferenceData } from "./read-reference";
import { MnyTransactionData, readTransactionData } from "./read-transactions";
import { TableAvailability } from "./table-reader";

/**
 * Reads every table the import needs out of an open Money file.
 *
 * This is the last layer that knows about Jet: mappers take `MnyTables` and
 * produce Monize entities without touching `mdb-reader`.
 */
export interface MnyTables {
  readonly reference: MnyReferenceData;
  readonly transactions: MnyTransactionData;
  readonly investments: MnyInvestmentData;
  readonly bills: MnyBillData;
  /** What each table supplied, for the preview's "this file lacks X" notices. */
  readonly availability: readonly TableAvailability[];
}

export function readMnyTables(db: MnyDatabase): MnyTables {
  const reference = readReferenceData(db);
  const transactions = readTransactionData(db);
  const investments = readInvestmentData(db);
  const bills = readBillData(db);

  return {
    reference,
    transactions,
    investments,
    bills,
    availability: [
      ...reference.availability,
      ...transactions.availability,
      ...investments.availability,
      bills.availability,
    ],
  };
}

/** Tables this Money version does not have at all. */
export function missingTables(tables: MnyTables): string[] {
  return tables.availability
    .filter((entry) => !entry.present)
    .map((entry) => entry.table);
}

/** Fields that fell back to a default because no source column was present. */
export function missingFields(tables: MnyTables): string[] {
  return tables.availability
    .filter((entry) => entry.present)
    .flatMap((entry) =>
      entry.missingFields.map((field) => `${entry.table}.${field}`),
    );
}
