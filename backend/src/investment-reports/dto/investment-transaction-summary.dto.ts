import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsUUID,
} from "class-validator";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";

/** A comma-separated query parameter, as a trimmed non-empty array. */
function csv({ value }: { value: unknown }): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return value;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * What the Investment Transaction History report is filtered by. The summary is
 * computed over the WHOLE filtered set, so the client's own paging -- which
 * stops at a fixed number of pages -- cannot turn a subtotal into a "total".
 */
export class InvestmentTransactionSummaryQueryDto {
  @ApiPropertyOptional({
    description: "Account ids to restrict the summary to (comma-separated)",
    type: [String],
  })
  @IsOptional()
  @Transform(csv)
  @IsArray()
  // Bounded for the reason `common/array-bound-dto.spec.ts` enforces: an
  // unbounded array is a lever on the query planner.
  @ArrayMaxSize(200)
  @IsUUID("4", { each: true })
  accountIds?: string[];

  @ApiPropertyOptional({
    description: "Earliest transaction date (YYYY-MM-DD)",
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: "Latest transaction date (YYYY-MM-DD)" })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    description: "Investment actions to restrict the summary to",
    enum: InvestmentAction,
    isArray: true,
  })
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @ArrayMaxSize(50)
  @IsEnum(InvestmentAction, { each: true })
  actions?: InvestmentAction[];
}

/**
 * One converted accumulation: the total only when every component converted,
 * the part that did convert beside it, and the pairs that stopped it.
 *
 * `total` and `knownSubtotal` are two fields rather than one because a caller
 * holding only the number cannot tell a complete 8,092.80 from a 4,339.00 with
 * a USD hole in it (`docs/financial-calculation-contract.md` section 1).
 */
export interface ConvertedAggregate {
  /** Complete total in the reporting currency, or `null` when anything is missing. */
  total: number | null;
  /** The components that did convert. Never printed under a "total" caption. */
  knownSubtotal: number;
  /** `"USD->PLN"` for each pair with no rate on the row's own date. */
  missingPairs: string[];
  /** Components left out with no currency to name (a row naming no security). */
  unknownCount: number;
  /**
   * Rows left out of `knownSubtotal` by either cause. The surface needs the
   * count as well as the pairs: "3 amounts excluded" and "no rate for USD->PLN"
   * are two independent clauses, and a set of pairs cannot supply the first.
   */
  excludedCount: number;
  /** Read as `=== false`: absent means no information. */
  fxComplete: boolean;
}

/** One action's slice of the filtered set. */
export interface InvestmentTransactionActionSummary extends ConvertedAggregate {
  action: InvestmentAction;
  /** Rows of this action, including any whose amount could not be converted. */
  count: number;
}

/** GET /reports/investment-transactions/summary. */
export interface InvestmentTransactionSummary extends ConvertedAggregate {
  /** The currency `total` and `knownSubtotal` are in. */
  currencyCode: string;
  /** Rows matching the filter, whether or not this client fetched them all. */
  transactionCount: number;
  /** Distinct security symbols across the filtered set. */
  securitiesTraded: number;
  byAction: InvestmentTransactionActionSummary[];
  /**
   * Distinct currencies the filtered rows' amounts are denominated in. More
   * than one means a table sorted by a raw amount is comparing across
   * currencies, which the report says out loud instead of doing silently.
   */
  amountCurrencies: string[];
  /** True when some row names no security, so its amount has no unit at all. */
  hasUnknownCurrency: boolean;
}
