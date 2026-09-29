import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { TransactionRule } from "./transaction-rule.entity";
import { TransactionRuleApplication } from "./transaction-rule-application.entity";
import { ActionHistoryModule } from "../action-history/action-history.module";
import { TagsModule } from "../tags/tags.module";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";
import { TransactionRulesRunService } from "./transaction-rules-run.service";
import { TransactionRulesService } from "./transaction-rules.service";
import { TransactionRulesController } from "./transaction-rules.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([TransactionRule, TransactionRuleApplication]),
    TagsModule,
    ActionHistoryModule,
  ],
  providers: [
    TransactionRulesService,
    TransactionRulesApplierService,
    TransactionRulesRunService,
  ],
  controllers: [TransactionRulesController],
  exports: [TransactionRulesService, TransactionRulesApplierService],
})
export class TransactionRulesModule {}
