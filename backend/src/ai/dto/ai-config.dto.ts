import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsIn,
  IsObject,
  IsNumber,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  Max,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsSafeConfigObject } from "../validators/safe-config-object.validator";
import { IsSafeProviderBaseUrl } from "../validators/safe-url.validator";
import {
  AI_PROVIDERS,
  AiProviderType,
} from "../entities/ai-provider-config.entity";
import { QUERY_BUDGET_SPECS } from "../query/query-budgets";

const BUDGETS = QUERY_BUDGET_SPECS;

/**
 * Per-query budget overrides for a provider the user configured themselves.
 * Every field is optional, and `null` clears it back to the built-in default.
 * The bounds come from `QUERY_BUDGET_SPECS`, so widening a range is one edit
 * in the table rather than three that have to agree.
 *
 * These deliberately do not exist for the centrally managed provider: it is
 * the operator's, it has no row to edit, and it is sized by the `AI_QUERY_*`
 * environment variables instead.
 */
export class QueryBudgetFieldsDto {
  @ApiPropertyOptional({
    example: BUDGETS.maxIterations.default,
    description: `Maximum ${BUDGETS.maxIterations.description}. Null uses the default (${BUDGETS.maxIterations.default}).`,
    minimum: BUDGETS.maxIterations.min,
    maximum: BUDGETS.maxIterations.max,
  })
  @IsOptional()
  @IsInt()
  @Min(BUDGETS.maxIterations.min)
  @Max(BUDGETS.maxIterations.max)
  queryMaxIterations?: number | null;

  @ApiPropertyOptional({
    example: BUDGETS.maxToolCalls.default,
    description: `Maximum ${BUDGETS.maxToolCalls.description}. Null uses the default (${BUDGETS.maxToolCalls.default}).`,
    minimum: BUDGETS.maxToolCalls.min,
    maximum: BUDGETS.maxToolCalls.max,
  })
  @IsOptional()
  @IsInt()
  @Min(BUDGETS.maxToolCalls.min)
  @Max(BUDGETS.maxToolCalls.max)
  queryMaxToolCalls?: number | null;

  @ApiPropertyOptional({
    example: BUDGETS.timeoutMinutes.default,
    description: `Maximum ${BUDGETS.timeoutMinutes.description}. Null uses the default (${BUDGETS.timeoutMinutes.default}).`,
    minimum: BUDGETS.timeoutMinutes.min,
    maximum: BUDGETS.timeoutMinutes.max,
  })
  @IsOptional()
  @IsInt()
  @Min(BUDGETS.timeoutMinutes.min)
  @Max(BUDGETS.timeoutMinutes.max)
  queryTimeoutMinutes?: number | null;

  @ApiPropertyOptional({
    example: BUDGETS.maxInputTokens.default,
    description: `Maximum ${BUDGETS.maxInputTokens.description}. Null uses the default (${BUDGETS.maxInputTokens.default}).`,
    minimum: BUDGETS.maxInputTokens.min,
    maximum: BUDGETS.maxInputTokens.max,
  })
  @IsOptional()
  @IsInt()
  @Min(BUDGETS.maxInputTokens.min)
  @Max(BUDGETS.maxInputTokens.max)
  queryMaxInputTokens?: number | null;

  @ApiPropertyOptional({
    example: BUDGETS.maxToolResultChars.default,
    description: `Maximum ${BUDGETS.maxToolResultChars.description}. Null uses the default (${BUDGETS.maxToolResultChars.default}).`,
    minimum: BUDGETS.maxToolResultChars.min,
    maximum: BUDGETS.maxToolResultChars.max,
  })
  @IsOptional()
  @IsInt()
  @Min(BUDGETS.maxToolResultChars.min)
  @Max(BUDGETS.maxToolResultChars.max)
  queryMaxToolResultChars?: number | null;
}

export class CreateAiConfigDto extends QueryBudgetFieldsDto {
  @ApiProperty({
    example: "anthropic",
    description: "AI provider type",
    enum: AI_PROVIDERS,
  })
  @IsString()
  @IsIn([...AI_PROVIDERS])
  provider: AiProviderType;

  @ApiPropertyOptional({
    example: "My Claude API",
    description: "User-friendly display name for this configuration",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  displayName?: string;

  @ApiPropertyOptional({
    example: "claude-sonnet-4-20250514",
    description: "Model identifier for the provider",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @ApiPropertyOptional({
    example: "sk-ant-...",
    description: "API key for the provider (will be encrypted at rest)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  apiKey?: string;

  @ApiPropertyOptional({
    example: "https://api.example.com",
    description:
      "Base URL for the provider (required for Ollama and OpenAI-compatible; optional for Ollama Cloud, defaults to https://ollama.com). Self-hosted providers allow private/local URLs.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @IsSafeProviderBaseUrl()
  baseUrl?: string;

  @ApiPropertyOptional({
    example: 0,
    description: "Priority for fallback ordering (lower = higher priority)",
    default: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;

  @ApiPropertyOptional({
    description: "Provider-specific settings (temperature, maxTokens, etc.)",
  })
  @IsOptional()
  @IsObject()
  @IsSafeConfigObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 3,
    description:
      "User-defined input cost per 1,000,000 tokens (for usage cost estimation). Set to null to clear.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1000000)
  inputCostPer1M?: number | null;

  @ApiPropertyOptional({
    example: 15,
    description:
      "User-defined output cost per 1,000,000 tokens (for usage cost estimation). Set to null to clear.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1000000)
  outputCostPer1M?: number | null;

  @ApiPropertyOptional({
    example: "USD",
    description:
      "ISO 4217 currency code for the cost rates (e.g. USD, EUR). Defaults to USD.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: "costCurrency must be a 3-letter ISO 4217 currency code",
  })
  costCurrency?: string;
}

export class UpdateAiConfigDto extends QueryBudgetFieldsDto {
  @ApiPropertyOptional({
    example: "My Claude API",
    description: "User-friendly display name",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  displayName?: string;

  @ApiPropertyOptional({
    example: "claude-sonnet-4-20250514",
    description: "Model identifier",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @ApiPropertyOptional({
    description: "New API key (will be encrypted, omit to keep existing)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  apiKey?: string;

  @ApiPropertyOptional({
    example: "https://api.example.com",
    description:
      "Base URL for the provider. Self-hosted providers allow private/local URLs.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @IsSafeProviderBaseUrl()
  baseUrl?: string;

  @ApiPropertyOptional({
    example: 0,
    description: "Priority for fallback ordering",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;

  @ApiPropertyOptional({
    example: true,
    description: "Whether this provider is active",
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: "Provider-specific settings",
  })
  @IsOptional()
  @IsObject()
  @IsSafeConfigObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 3,
    description:
      "User-defined input cost per 1,000,000 tokens (for usage cost estimation). Pass null to clear.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1000000)
  inputCostPer1M?: number | null;

  @ApiPropertyOptional({
    example: 15,
    description:
      "User-defined output cost per 1,000,000 tokens (for usage cost estimation). Pass null to clear.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1000000)
  outputCostPer1M?: number | null;

  @ApiPropertyOptional({
    example: "USD",
    description: "ISO 4217 currency code for the cost rates (e.g. USD, EUR).",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: "costCurrency must be a 3-letter ISO 4217 currency code",
  })
  costCurrency?: string;
}

/**
 * Body of the "test this draft before saving" endpoint. Users can hit the
 * inline Test button in the provider form even when the config hasn't been
 * persisted yet -- we accept the in-progress values here and probe the
 * resulting provider without writing anything to the database.
 *
 * When editing an existing provider, `configId` may be supplied so the
 * server falls back to the already-stored API key if the user hasn't
 * typed a new one (the form doesn't echo the stored key back to the
 * client for obvious reasons).
 */
export class TestAiConfigDto {
  @ApiProperty({
    example: "anthropic",
    description: "AI provider type",
    enum: AI_PROVIDERS,
  })
  @IsString()
  @IsIn([...AI_PROVIDERS])
  provider: AiProviderType;

  @ApiPropertyOptional({
    example: "claude-sonnet-4-20250514",
    description: "Model identifier to verify",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @ApiPropertyOptional({
    example: "sk-ant-...",
    description:
      "API key (omitted when falling back to a stored key via configId)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  apiKey?: string;

  @ApiPropertyOptional({
    example: "https://api.example.com",
    description: "Base URL override",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @IsSafeProviderBaseUrl()
  baseUrl?: string;

  @ApiPropertyOptional({
    description:
      "Existing configuration id to inherit the stored API key from when apiKey is omitted",
  })
  @IsOptional()
  @IsUUID()
  configId?: string;
}
