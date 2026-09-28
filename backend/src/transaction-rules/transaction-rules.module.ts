import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { TransactionRule } from "./transaction-rule.entity";
import { TransactionRuleApplication } from "./transaction-rule-application.entity";
import { TagsModule } from "../tags/tags.module";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";
import { TransactionRulesService } from "./transaction-rules.service";
import { TransactionRulesController } from "./transaction-rules.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([TransactionRule, TransactionRuleApplication]),
    TagsModule,
  ],
  providers: [TransactionRulesService, TransactionRulesApplierService],
  controllers: [TransactionRulesController],
  exports: [TransactionRulesService, TransactionRulesApplierService],
})
export class TransactionRulesModule {}
