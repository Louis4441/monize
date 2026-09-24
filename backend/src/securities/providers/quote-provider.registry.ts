import { Injectable } from "@nestjs/common";
import { MsnFinanceService } from "../msn-finance.service";
import { YahooFinanceService } from "../yahoo-finance.service";
import { LseFinanceService } from "../lse-finance.service";
import { DeutscheBoerseFinanceService } from "../deutsche-boerse-finance.service";
import { Security } from "../entities/security.entity";
import { QuoteProvider, QuoteProviderName } from "./quote-provider.interface";

export const DEFAULT_QUOTE_PROVIDER: QuoteProviderName = "yahoo";

@Injectable()
export class QuoteProviderRegistry {
  constructor(
    private readonly yahoo: YahooFinanceService,
    private readonly msn: MsnFinanceService,
    private readonly lse: LseFinanceService,
    private readonly deutscheBoerse: DeutscheBoerseFinanceService,
  ) {}

  getByName(name: QuoteProviderName): QuoteProvider {
    switch (name) {
      case "msn":
        return this.msn;
      case "lse":
        return this.lse;
      case "deutsche_boerse":
        return this.deutscheBoerse;
      default:
        return this.yahoo;
    }
  }

  listAll(): QuoteProvider[] {
    return [this.yahoo, this.msn, this.lse, this.deutscheBoerse];
  }

  /**
   * Return providers in order [primary, fallback] for a security.
   * Primary = security override, else user default, else "yahoo".
   * Fallback = the other provider (if any).
   */
  resolveForSecurity(
    security: Pick<Security, "quoteProvider">,
    userDefault: QuoteProviderName | null | undefined,
  ): QuoteProvider[] {
    const primary: QuoteProviderName =
      (security.quoteProvider as QuoteProviderName | null) ??
      userDefault ??
      DEFAULT_QUOTE_PROVIDER;

    const providers: QuoteProvider[] = [this.getByName(primary)];
    for (const p of this.listAll()) {
      if (p.name !== primary) providers.push(p);
    }
    return providers;
  }
}
