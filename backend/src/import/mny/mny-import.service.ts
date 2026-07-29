import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { withUserContext } from "../../common/db/with-context";
import { Account } from "../../accounts/entities/account.entity";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { UsersService } from "../../users/users.service";
import { CurrenciesService } from "../../currencies/currencies.service";
import { roundMoney } from "../../common/round.util";
import { tr } from "../../i18n/translate";
import { ImportPostProcessingService } from "../import-post-processing.service";
import { ImportJob } from "./entities/import-job.entity";
import { MnyStagedFileMissingError } from "./mny-errors";
import { JobRunContext, MnyImportJobService } from "./mny-import-job.service";
import { MnyParsedFile, MnyParserService } from "./mny-parser.service";
import { MnyStagingService } from "./mny-staging.service";
import {
  MnyAccountVerification,
  MnyImportResult,
  balanceMatches,
} from "./model/mny-import-job";
import {
  MnyImportOptions,
  resolveImportOptions,
} from "./model/mny-import-options";
import { MnyWarning, summarizeWarnings } from "./model/mny-warnings";
import {
  applyDeferredClosures,
  writeAccounts,
  writeCategories,
  writePayees,
} from "./writers/write-reference";
import {
  writeAccountBalances,
  writeTransactions,
} from "./writers/write-transactions";

/**
 * Runs a `.mny` import: staged bytes in, Monize rows and a verification report
 * out.
 *
 * The whole write is one transaction, so a failure leaves nothing behind and
 * Retry cannot double-import. Progress still reaches the wizard mid-flight
 * because the job service publishes it on its own connection -- see
 * `runOutsideActiveScopedManager`.
 *
 * The optional "start fresh" wipe happens in `start`, **before** the job exists,
 * for a security reason as much as an ordering one: `UsersService.deleteData`
 * re-authenticates, and its credentials must never be written into
 * `import_jobs.options`.
 */

/** Credentials the existing delete-my-data operation requires. */
export interface WipeCredentials {
  readonly password?: string;
  readonly oidcIdToken?: string;
}

export interface StartImportInput {
  readonly stagedFileId: string;
  readonly options?: Partial<MnyImportOptions>;
  readonly wipeCredentials?: WipeCredentials;
}

@Injectable()
export class MnyImportService {
  private readonly logger = new Logger(MnyImportService.name);

  constructor(
    private dataSource: DataSource,
    private staging: MnyStagingService,
    private parser: MnyParserService,
    private jobs: MnyImportJobService,
    private postProcessing: ImportPostProcessingService,
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
    @Inject(forwardRef(() => CurrenciesService))
    private currencies: CurrenciesService,
  ) {}

  /**
   * Validates, optionally wipes, creates the job and starts it in the
   * background. Returns the job row the wizard polls.
   */
  async start(userId: string, input: StartImportInput): Promise<ImportJob> {
    const staged = await this.staging.findInfo(userId, input.stagedFileId);
    if (!staged) {
      throw new NotFoundException(
        tr(
          "errors.import.mnyStagedFileMissing",
          "The uploaded Money file is no longer available. Please upload it again.",
        ),
      );
    }

    if (await this.jobs.hasActiveJob(userId)) {
      throw new ConflictException(
        tr(
          "errors.import.mnyImportAlreadyRunning",
          "An import is already running. Wait for it to finish before starting another.",
        ),
      );
    }

    const options = resolveImportOptions(input.options);

    // Before the job row exists, and never with the credentials in tow: a
    // failed re-authentication must fail the request, not a background job.
    if (options.wipeExistingData) {
      await this.usersService.deleteData(userId, {
        password: input.wipeCredentials?.password,
        oidcIdToken: input.wipeCredentials?.oidcIdToken,
        deleteAccounts: true,
        deleteCategories: true,
        deletePayees: true,
      });
      this.logger.log(
        `Wiped existing data for user ${userId} before .mny import`,
      );
    }

    const job = await this.jobs.create(userId, staged.id, options);

    // Unawaited on purpose (design ADR-3): the request returns the job id and
    // the wizard polls. `withUserContext` keeps an identity for the async chain
    // once the request scope is gone.
    void withUserContext(userId, () =>
      this.jobs.runClaimed(userId, job.id, (context) =>
        this.runImport(userId, staged.id, options, context),
      ),
    ).catch((error) =>
      this.logger.error(
        `Import job ${job.id} could not be started: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );

    return job;
  }

  /**
   * The job body. Parses the staged bytes again rather than trusting a
   * serialized preview, so what is written is provably what the preview showed.
   */
  async runImport(
    userId: string,
    stagedFileId: string,
    options: MnyImportOptions,
    context: JobRunContext,
  ): Promise<MnyImportResult> {
    await context.reportProgress({
      phase: "preparing",
      processed: 0,
      total: 0,
    });

    const bytes = await this.staging.loadBytes(userId, stagedFileId);
    if (!bytes) {
      throw new MnyStagedFileMissingError(stagedFileId);
    }

    const parsed = this.parser.parse({
      buffer: bytes,
      options,
      userDefaultCurrency: await this.defaultCurrency(userId),
    });

    // Currencies are global reference data with their own idempotent creation
    // path, so they are ensured before the import transaction opens.
    for (const code of parsed.accounts.currencyCodes) {
      await this.currencies.ensureSystemCurrency(code);
    }

    const written = await this.writeAll(userId, parsed, context);

    await context.reportProgress({
      phase: "finalizing",
      processed: 0,
      total: 0,
    });
    await this.postProcessing.run(
      userId,
      false,
      new Set(written.affectedAccountIds),
    );

    await context.reportProgress({
      phase: "verifying",
      processed: 0,
      total: 0,
    });
    const verification = await this.verify(
      userId,
      parsed,
      written.accountIdByKey,
    );

    // Delete-on-complete: the bytes have done their job, and they are the
    // largest thing this feature stores.
    await this.staging.remove(userId, stagedFileId);

    const warnings: MnyWarning[] = [
      ...parsed.warnings,
      ...verification
        .filter((account) => !account.matches)
        .map((account) => ({
          code: "balanceMismatch" as const,
          subject: account.accountName,
          detail: `delta ${account.delta}`,
        })),
    ];

    return {
      accountsCreated: written.accountsCreated,
      payeesCreated: written.payeesCreated,
      categoriesCreated: written.categoriesCreated,
      transactionsCreated: written.transactionsCreated,
      splitsCreated: written.splitsCreated,
      transfersLinked: parsed.transactions.transfersLinked,
      // Phase 2 fills these in; they are reported as zero rather than omitted so
      // the report's shape does not change when investments land.
      securitiesCreated: 0,
      investmentTransactionsCreated: 0,
      pricesImported: 0,
      exchangeRatesImported: 0,
      billsCreated: 0,
      skipped: {
        accounts: parsed.accounts.skipped,
        payees: parsed.payees.skipped,
        categories: parsed.categories.skipped,
        transactions: parsed.transactions.skipped,
      },
      existingDataRemoved: options.wipeExistingData,
      verification,
      warnings: summarizeWarnings(warnings),
    };
  }

  /** Everything that has to be atomic, in one transaction. */
  private async writeAll(
    userId: string,
    parsed: MnyParsedFile,
    context: JobRunContext,
  ): Promise<{
    accountIdByKey: ReadonlyMap<string, string>;
    accountsCreated: number;
    categoriesCreated: number;
    payeesCreated: number;
    transactionsCreated: number;
    splitsCreated: number;
    affectedAccountIds: ReadonlySet<string>;
  }> {
    return withScopedDb(this.dataSource, async (manager) => {
      await context.reportProgress({
        phase: "reference",
        processed: 0,
        total: parsed.accounts.accounts.length,
      });

      const accounts = await writeAccounts(
        manager,
        userId,
        parsed.accounts.accounts,
      );
      const categories = await writeCategories(
        manager,
        userId,
        parsed.categories.categories,
      );
      const payees = await writePayees(manager, userId, parsed.payees.payees);

      await context.reportProgress({
        phase: "transactions",
        processed: 0,
        total: parsed.transactions.transactions.length,
      });

      const transactions = await writeTransactions(manager, userId, {
        transactions: parsed.transactions.transactions,
        accountIdByKey: accounts.idByKey,
        categoryIdByHandle: this.categoryIdsByHandle(
          parsed,
          categories.idByFullName,
        ),
        payeeIdByHandle: this.payeeIdsByHandle(parsed, payees.idByName),
        payeeNameByHandle: parsed.payees.nameByHandle,
        onProgress: (processed, total) =>
          context.reportProgress({ phase: "transactions", processed, total }),
      });

      // One balance write from the file-computed totals; post-processing then
      // recomputes the same numbers from the rows as a cross-check.
      await writeAccountBalances(
        manager,
        new Map(
          [...parsed.expectedBalances]
            .map(([key, balance]): [string | undefined, number] => [
              accounts.idByKey.get(key),
              balance,
            ])
            .filter(
              (entry): entry is [string, number] => entry[0] !== undefined,
            ),
        ),
      );

      // Last, because a closed account rejects balance updates.
      await applyDeferredClosures(
        manager,
        userId,
        parsed.accounts.accounts,
        accounts.idByKey,
      );

      return {
        accountIdByKey: accounts.idByKey,
        accountsCreated: accounts.created,
        categoriesCreated: categories.created,
        payeesCreated: payees.created,
        transactionsCreated: transactions.transactionsCreated,
        splitsCreated: transactions.splitsCreated,
        affectedAccountIds: transactions.affectedAccountIds,
      };
    });
  }

  /** Money `hcat` -> Monize category id, through the mapper's full names. */
  private categoryIdsByHandle(
    parsed: MnyParsedFile,
    idByFullName: ReadonlyMap<string, string>,
  ): Map<number, string> {
    return new Map(
      [...parsed.categories.byHandle]
        .map(([handle, category]): [number, string | undefined] => [
          handle,
          idByFullName.get(category.fullName),
        ])
        .filter((entry): entry is [number, string] => entry[1] !== undefined),
    );
  }

  /** Money `hpay` -> Monize payee id, through the mapper's names. */
  private payeeIdsByHandle(
    parsed: MnyParsedFile,
    idByName: ReadonlyMap<string, string>,
  ): Map<number, string> {
    return new Map(
      [...parsed.payees.nameByHandle]
        .map(([handle, name]): [number, string | undefined] => [
          handle,
          idByName.get(name),
        ])
        .filter((entry): entry is [number, string] => entry[1] !== undefined),
    );
  }

  /**
   * Compares the balance each account ended up with against the balance computed
   * from the Money file. This is the trust-builder both PR #192 testers asked
   * for: 56 accounts is too many to reconcile by hand.
   */
  private async verify(
    userId: string,
    parsed: MnyParsedFile,
    accountIdByKey: ReadonlyMap<string, string>,
  ): Promise<MnyAccountVerification[]> {
    const ids = [...accountIdByKey.values()];
    if (ids.length === 0) {
      return [];
    }

    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(Account).find({
        where: ids.map((id) => ({ id, userId })),
        select: ["id", "currentBalance"],
      }),
    );
    const balanceById = new Map(
      rows.map((row) => [row.id, Number(row.currentBalance)]),
    );

    return parsed.accounts.accounts.map((account) => {
      const accountId = accountIdByKey.get(account.key) ?? null;
      const expectedBalance = parsed.expectedBalances.get(account.key) ?? 0;
      const importedBalance =
        accountId === null ? 0 : (balanceById.get(accountId) ?? 0);
      const delta = roundMoney(importedBalance - expectedBalance);

      return {
        accountName: account.name,
        accountId,
        expectedBalance,
        importedBalance,
        delta,
        transactionCount: parsed.transactionCounts.get(account.key) ?? 0,
        matches: balanceMatches(delta),
      };
    });
  }

  /** The user's preferred currency, used only when the file names none. */
  private async defaultCurrency(userId: string): Promise<string> {
    const preference = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    return preference?.defaultCurrency ?? "USD";
  }
}
