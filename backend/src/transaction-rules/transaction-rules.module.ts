import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { TransactionRule } from "./transaction-rule.entity";
import { TransactionRuleApplication } from "./transaction-rule-application.entity";
import { TransactionRulesService } from "./transaction-rules.service";
import { TransactionRulesController } from "./transaction-rules.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([TransactionRule, TransactionRuleApplication]),
  ],
  providers: [TransactionRulesService],
  controllers: [TransactionRulesController],
  exports: [TransactionRulesService],
})
export class TransactionRulesModule {}
