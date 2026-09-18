import { Module, forwardRef } from "@nestjs/common";
import { ExchangeRateService } from "./exchange-rate.service";
import { ExchangeRateHistoryService } from "./exchange-rate-history.service";
import { CurrenciesService } from "./currencies.service";
import { CurrenciesController } from "./currencies.controller";
import { SecuritiesModule } from "../securities/securities.module";

@Module({
  imports: [forwardRef(() => SecuritiesModule)],
  providers: [
    ExchangeRateService,
    ExchangeRateHistoryService,
    CurrenciesService,
  ],
  controllers: [CurrenciesController],
  exports: [ExchangeRateService, ExchangeRateHistoryService, CurrenciesService],
})
export class CurrenciesModule {}
