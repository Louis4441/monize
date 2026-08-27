import { Module, forwardRef } from "@nestjs/common";
import { ExchangeRateService } from "./exchange-rate.service";
import { CurrenciesService } from "./currencies.service";
import { CurrenciesController } from "./currencies.controller";
import { SecuritiesModule } from "../securities/securities.module";
import { ProviderHealthModule } from "../provider-health/provider-health.module";

@Module({
  imports: [forwardRef(() => SecuritiesModule), ProviderHealthModule],
  providers: [ExchangeRateService, CurrenciesService],
  controllers: [CurrenciesController],
  exports: [ExchangeRateService, CurrenciesService],
})
export class CurrenciesModule {}
