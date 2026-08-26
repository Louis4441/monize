import { Module } from "@nestjs/common";
import { ProviderHealthService } from "./provider-health.service";

/**
 * Availability tracking for the outbound market-data providers.
 *
 * Deliberately a leaf: it depends on nothing but `DataSource`, so the provider
 * clients (`SecuritiesModule`) can import it and the alert cron
 * (`NotificationsModule`, which owns every email in this codebase) can import
 * it too, with no cycle between them.
 */
@Module({
  providers: [ProviderHealthService],
  exports: [ProviderHealthService],
})
export class ProviderHealthModule {}
