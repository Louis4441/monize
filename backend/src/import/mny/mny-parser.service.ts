import { Injectable, Logger } from "@nestjs/common";
import { MnyDatabase, openMnyFile } from "./msisam/open-mny";
import {
  MnyTables,
  missingFields,
  missingTables,
  readMnyTables,
} from "./tables/read-mny-tables";
import { mapAccounts, mapCategories, mapPayees } from "./map/map-reference";
import { mapTransactions } from "./map/map-transactions";
import {
  MappedAccounts,
  MappedCategories,
  MappedPayees,
  MappedTransactions,
} from "./model/mny-import-model";
import {
  MnyImportOptions,
  resolveImportOptions,
} from "./model/mny-import-options";
import { MnyWarning } from "./model/mny-warnings";
import { isCurrencyPseudoSecurity } from "./model/mny-model";
import { TransactionStatus } from "../../transactions/entities/transaction.entity";
import { roundMoney } from "../../common/round.util";

/**
 * Decrypt -> read -> map, in one place.
 *
 * Called twice per import, on purpose: once for the wizard's preview and again
 * by the background job over the same staged bytes (design ADR-2). Parsing is
 * deterministic, so there is no serialized intermediate representation that can
 * drift from what the preview promised -- and the balances the preview shows are
 * the same numbers the verification report reconciles against.
 *
 * Nothing here touches the database.
 */

/** Which Money era a file was written by, inferred from its table/column set. */
export type MnyEra = "money2001" | "money2002" | "moneyPlus" | "unknown";

export interface MnyParseInput {
  /** Decrypted or still-encrypted file bytes. Ownership passes to the parser. */
  readonly buffer: Buffer;
  /** Money file password, when the file needs one. Never logged, never stored. */
  readonly password?: string;
  readonly options?: Partial<MnyImportOptions>;
  /** Used as the base currency only when the file names none. */
  readonly userDefaultCurrency: string;
  /**
   * Balance cut-off, `YYYY-MM-DD`. Future-dated transactions are excluded from
   * expected balances because Monize's own balance recalculation excludes them;
   * comparing against a total that included them would report a discrepancy on
   * every account holding a post-dated cheque.
   */
  readonly asOf?: string;
}

export interface MnyParsedFile {
  readonly era: MnyEra;
  readonly passwordProtected: boolean;
  readonly options: MnyImportOptions;
  readonly baseCurrency: string;
  readonly accounts: MappedAccounts;
  readonly transactions: MappedTransactions;
  readonly categories: MappedCategories;
  readonly payees: MappedPayees;
  /** Account key -> final balance computed from the file itself. */
  readonly expectedBalances: ReadonlyMap<string, number>;
  /** Account key -> number of transactions this import will create. */
  readonly transactionCounts: ReadonlyMap<string, number>;
  /** Raw file counts for the things Phase 1 does not import yet. */
  readonly fileCounts: MnyFileCounts;
  readonly missingTables: readonly string[];
  readonly missingFields: readonly string[];
  readonly warnings: readonly MnyWarning[];
}

export interface MnyFileCounts {
  readonly accounts: number;
  readonly payees: number;
  readonly categories: number;
  /** Excludes Money's currency pseudo-securities. */
  readonly securities: number;
  readonly securityPrices: number;
  readonly exchangeRates: number;
  readonly bills: number;
  readonly transactions: number;
}

/** Today in the local calendar, as the repository's `YYYY-MM-DD` DATE strings. */
export function todayIsoDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Which Money release wrote this file, from what the reader could resolve.
 *
 * Money Plus renamed `TRN.hpay` to `lHpay`, and `BILL` did not exist before
 * Money 2002. Those two facts separate the three vintages the fixtures cover.
 */
export function detectEra(tables: MnyTables, db: MnyDatabase): MnyEra {
  const transactionTable = tables.availability.find(
    (entry) => entry.table === "TRN",
  );
  if (!transactionTable?.present) {
    return "unknown";
  }
  if (transactionTable.resolvedColumns.payee === "lHpay") {
    return "moneyPlus";
  }
  return db.hasTable("BILL") ? "money2002" : "money2001";
}

/**
 * Per-account final balances, computed from the file the same way Monize
 * computes `current_balance`: opening balance plus every non-void transaction
 * dated on or before the cut-off. This is the verification report's baseline, so
 * it must mirror `postImportProcessing`'s query exactly rather than being a
 * second, subtly different definition of "balance".
 */
export function computeExpectedBalances(
  accounts: MappedAccounts,
  transactions: MappedTransactions,
  asOf: string,
): Map<string, number> {
  const totals = new Map<string, number>(
    accounts.accounts.map((account) => [
      account.key,
      Math.round(account.openingBalance * 10000),
    ]),
  );

  for (const transaction of transactions.transactions) {
    if (
      transaction.status === TransactionStatus.VOID ||
      transaction.transactionDate > asOf
    ) {
      continue;
    }
    const current = totals.get(transaction.accountKey);
    if (current === undefined) {
      continue;
    }
    // Integer minor units throughout: 37,000 float additions drift.
    totals.set(
      transaction.accountKey,
      current + Math.round(transaction.amount * 10000),
    );
  }

  return new Map(
    [...totals].map(([key, minorUnits]) => [
      key,
      roundMoney(minorUnits / 10000),
    ]),
  );
}

function countTransactionsByAccount(
  transactions: MappedTransactions,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const transaction of transactions.transactions) {
    counts.set(
      transaction.accountKey,
      (counts.get(transaction.accountKey) ?? 0) + 1,
    );
  }
  return counts;
}

function fileCounts(tables: MnyTables): MnyFileCounts {
  return {
    accounts: tables.reference.accounts.length,
    payees: tables.reference.payees.length,
    // Money's two structural roots are not categories.
    categories: tables.reference.categories.filter(
      (category) => category.level > 0,
    ).length,
    securities: tables.investments.securities.filter(
      (security) =>
        !isCurrencyPseudoSecurity(security.securityType, security.symbol),
    ).length,
    securityPrices: tables.investments.prices.length,
    exchangeRates: tables.reference.exchangeRates.length,
    bills: tables.bills.bills.length,
    transactions: tables.transactions.transactions.length,
  };
}

@Injectable()
export class MnyParserService {
  private readonly logger = new Logger(MnyParserService.name);

  /**
   * Parses a Money file into the import model.
   *
   * @throws MnyImportError subclasses -- truncated, not a Money file, Jet 3,
   *   password required, password incorrect, unreadable
   */
  parse(input: MnyParseInput): MnyParsedFile {
    const options = resolveImportOptions(input.options);
    const db = openMnyFile(input.buffer, input.password);
    const tables = readMnyTables(db);
    const era = detectEra(tables, db);

    const accounts = mapAccounts(
      tables.reference,
      options,
      input.userDefaultCurrency,
    );
    const transactions = mapTransactions({
      transactions: tables.transactions,
      accountKeyByHandle: accounts.keyByHandle,
      currencyByHandle: accounts.currencyByHandle,
      bills: tables.bills.bills,
    });
    const categories = mapCategories(
      tables.reference,
      options.referencedOnlyCategories
        ? transactions.referencedCategories
        : null,
    );
    const payees = mapPayees(
      tables.reference.payees,
      options.referencedOnlyPayees ? transactions.referencedPayees : null,
    );

    const absentTables = missingTables(tables);
    const defaultedFields = missingFields(tables);

    this.logger.log(
      `Parsed ${era} file: ${accounts.accounts.length} accounts, ` +
        `${transactions.transactions.length} transactions, ` +
        `${transactions.deferredInvestments} investment rows deferred`,
    );

    return {
      era,
      passwordProtected: db.passwordProtected,
      options,
      baseCurrency: accounts.baseCurrency,
      accounts,
      transactions,
      categories,
      payees,
      expectedBalances: computeExpectedBalances(
        accounts,
        transactions,
        input.asOf ?? todayIsoDate(),
      ),
      transactionCounts: countTransactionsByAccount(transactions),
      fileCounts: fileCounts(tables),
      missingTables: absentTables,
      missingFields: defaultedFields,
      warnings: [
        ...absentTables.map((table) => ({
          code: "missingTable" as const,
          subject: table,
        })),
        ...defaultedFields.map((field) => ({
          code: "missingField" as const,
          subject: field,
        })),
        ...accounts.warnings,
        ...transactions.warnings,
        ...categories.warnings,
        ...payees.warnings,
      ],
    };
  }
}
