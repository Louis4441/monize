import { BadRequestException, Injectable } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { AiService } from "../../ai/ai.service";
import {
  parseContactJson,
  sanitizeContactSuggestions,
} from "./contact-suggestion.sanitize";
import {
  buildPayeeLookupUserMessage,
  PAYEE_LOOKUP_FEATURE,
  PAYEE_LOOKUP_MAX_SEARCHES,
  PAYEE_LOOKUP_MAX_TOKENS,
  PAYEE_LOOKUP_SYSTEM_PROMPT,
} from "./payee-lookup.prompt";
import {
  ContactLookupSource,
  ContactLookupUnavailableError,
  PayeeContactLookupInput,
  PayeeContactLookupProvider,
  PayeeContactSuggestion,
} from "./payee-contact-lookup.types";

/**
 * The lookup adapter backed by the user's own AI configuration. Every
 * provider the user has serves it, in their priority order:
 * `AiService.completeWithWebSearch` runs a real search where the provider has
 * one, hands the prompt to the relay agent, or falls back to model knowledge
 * -- and reports which, so the answer is stamped with the source that
 * decides how far it is trusted.
 */
@Injectable()
export class AiPayeeContactLookupProvider implements PayeeContactLookupProvider {
  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * Resolved lazily rather than injected: AiModule imports PayeesModule (the
   * assistant's actions create payees), so a PayeesModule -> AiModule edge
   * would put PayeesModule on a require cycle with every module that imports
   * it bare (`module-graph.spec.ts` names eight). Same pattern as
   * `UsersService` / `AuthService`.
   */
  private get aiService(): AiService {
    return this.moduleRef.get(AiService, { strict: false });
  }

  async lookup(
    userId: string,
    input: PayeeContactLookupInput,
  ): Promise<PayeeContactSuggestion[]> {
    const configs = await this.aiService.getActiveConfigs(userId);
    if (configs.length === 0) {
      throw new ContactLookupUnavailableError("no_provider");
    }

    let response;
    try {
      response = await this.aiService.completeWithWebSearch(
        userId,
        {
          systemPrompt: PAYEE_LOOKUP_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildPayeeLookupUserMessage(
                input.name,
                input.hint,
                input.known,
              ),
            },
          ],
          temperature: 0,
          maxTokens: PAYEE_LOOKUP_MAX_TOKENS,
          responseFormat: "json",
        },
        { maxUses: PAYEE_LOOKUP_MAX_SEARCHES },
        PAYEE_LOOKUP_FEATURE,
      );
    } catch (error) {
      // AiService's BadRequestExceptions are the user-actionable ones: relay
      // agent offline, relay timed out, every provider failed. Carry the
      // message so the UI can show that instead of a generic failure.
      if (error instanceof BadRequestException) {
        throw new ContactLookupUnavailableError("failed", error.message);
      }
      throw error;
    }

    const parsed = parseContactJson(response.content);
    if (!parsed) return [];

    const source: ContactLookupSource = response.searched
      ? "ai-web-search"
      : response.viaRelay
        ? "ai-relay"
        : "ai-knowledge";
    return sanitizeContactSuggestions(parsed, source, input.known);
  }
}
