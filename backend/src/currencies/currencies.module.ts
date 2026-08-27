import { Module, forwardRef } from "@nestjs/common";
import { ExchangeRateService } from "./exchange-rate.service";
import { CurrenciesService } from "./currencies.service";
import { CurrenciesController } from "./currencies.controller";
import { SecuritiesModule } from "../securities/securities.module";

@Module({
  imports: [forwardRef(() => SecuritiesModule)],
  providers: [ExchangeRateService, CurrenciesService],
  controllers: [CurrenciesController],
  exports: [ExchangeRateService, CurrenciesService],
})
export class CurrenciesModule {}
