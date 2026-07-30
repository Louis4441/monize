import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ImportController } from "./import.controller";
import { MnyImportController } from "./mny/mny-import.controller";
import { ImportService } from "./import.service";
import { ImportEntityCreatorService } from "./import-entity-creator.service";
import { ImportInvestmentProcessorService } from "./import-investment-processor.service";
import { ImportRegularProcessorService } from "./import-regular-processor.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Account } from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Security } from "../securities/entities/security.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { Holding } from "../securities/entities/holding.entity";
import { ImportColumnMapping } from "./entities/import-column-mapping.entity";
import { ImportJob } from "./mny/entities/import-job.entity";
import { ImportStagedFile } from "./mny/entities/import-staged-file.entity";
import { MnyImportJobService } from "./mny/mny-import-job.service";
import { MnyImportService } from "./mny/mny-import.service";
import { ImportPostProcessingService } from "./import-post-processing.service";
import { MnyParserService } from "./mny/mny-parser.service";
import { MnyStagingService } from "./mny/mny-staging.service";
import { NetWorthModule } from "../net-worth/net-worth.module";
import { SecuritiesModule } from "../securities/securities.module";
import { CurrenciesModule } from "../currencies/currencies.module";
import { UsersModule } from "../users/users.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Transaction,
      TransactionSplit,
      Account,
      Category,
      Payee,
      Security,
      InvestmentTransaction,
      Holding,
      ImportColumnMapping,
      // Registered so TypeORM knows the entities; the .mny services reach them
      // through withScopedDb rather than through injected repositories.
      ImportStagedFile,
      ImportJob,
    ]),
    forwardRef(() => NetWorthModule),
    forwardRef(() => SecuritiesModule),
    forwardRef(() => CurrenciesModule),
    forwardRef(() => UsersModule),
  ],
  controllers: [ImportController, MnyImportController],
  providers: [
    ImportService,
    ImportPostProcessingService,
    ImportEntityCreatorService,
    ImportInvestmentProcessorService,
    ImportRegularProcessorService,
    MnyStagingService,
    MnyParserService,
    MnyImportJobService,
    MnyImportService,
  ],
  exports: [
    ImportService,
    MnyStagingService,
    MnyParserService,
    MnyImportJobService,
    MnyImportService,
  ],
})
export class ImportModule {}
