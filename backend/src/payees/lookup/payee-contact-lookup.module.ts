import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ActionHistoryModule } from "../../action-history/action-history.module";
import { FaviconModule } from "../../common/favicon/favicon.module";
import { Payee } from "../entities/payee.entity";
import { PayeeContactEnrichmentService } from "./payee-contact-enrichment.service";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { AiPayeeContactLookupProvider } from "./ai-payee-contact-lookup.provider";
import { PayeeContactLookupService } from "./payee-contact-lookup.service";
import { PAYEE_CONTACT_LOOKUP_PROVIDER } from "./payee-contact-lookup.types";

/**
 * Which data source answers a contact lookup is decided here, once.
 *
 * Today that is the user's own AI configuration. A Google Places adapter
 * (`websiteUri`, `nationalPhoneNumber`, `formattedAddress`; no email) would be
 * a second class implementing `PayeeContactLookupProvider`, and this binding
 * would become a `useFactory` choosing between the two from an operator
 * setting (`PAYEE_LOOKUP_PROVIDER=ai|google-places` with
 * `GOOGLE_PLACES_API_KEY`) -- the deployment's own resource, per the env-var
 * rule in backend/CLAUDE.md -- with its own `ProviderHealthService` id and its
 * own row in docs/external-side-effects.md. Nothing outside this module
 * knows which adapter is bound.
 */
@Module({
  // Deliberately no AiModule import: the AI adapter resolves AiService lazily
  // through ModuleRef so this module sits off every require cycle.
  imports: [
    TypeOrmModule.forFeature([UserPreference, Payee]),
    ActionHistoryModule,
    FaviconModule,
  ],
  providers: [
    PayeeContactLookupService,
    PayeeContactEnrichmentService,
    AiPayeeContactLookupProvider,
    {
      provide: PAYEE_CONTACT_LOOKUP_PROVIDER,
      useExisting: AiPayeeContactLookupProvider,
    },
  ],
  exports: [PayeeContactLookupService, PayeeContactEnrichmentService],
})
export class PayeeContactLookupModule {}
