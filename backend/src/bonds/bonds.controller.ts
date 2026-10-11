import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { todayYMD } from "../common/date-utils";
import { tr } from "../i18n/translate";
import { BondCatalogService } from "./bond-catalog.service";
import {
  BondDataInconsistentCode,
  BondDataInconsistentError,
  BondDataNotFoundCode,
  BondDataNotFoundError,
  BondErrorParams,
} from "./bond-errors";
import { BondPriceRecompute, BondPriceService } from "./bond-price.service";
import {
  BondInstrumentSummary,
  BondValuationService,
  SecurityValuation,
} from "./bond-valuation.service";
import { BondScenarios } from "./bond-scenarios";
import {
  ParseAssumePipe,
  ParseBondAsOfPipe,
  ParseBenchmarkIdPipe,
  ParseScenarioValuesPipe,
} from "./bond-query.pipes";
import { BondEngineError, BondEngineErrorCode } from "./engine/bond-engine";

/**
 * The bond catalog, a linked security's lots valued on a day, and the on-demand
 * price recompute (spec 12.5). Owner-scoped: `userId` comes from the JWT only,
 * and another user's security answers 404 exactly as an unlinked one does.
 */
@ApiTags("Bonds")
@Controller("bonds")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class BondsController {
  constructor(
    private readonly catalog: BondCatalogService,
    private readonly valuation: BondValuationService,
    private readonly prices: BondPriceService,
  ) {}

  @Get("instruments")
  @ApiOperation({
    summary: "List the bond instruments a security can be linked to",
    description:
      "The deployment's catalog (global reference data), ordered by issuer " +
      "country, issuer and series, for the link picker.",
  })
  @ApiResponse({ status: 200, description: "Bond instruments" })
  listInstruments(): Promise<BondInstrumentSummary[]> {
    return this.catalog.listInstruments();
  }

  @Get("securities/:securityId/valuation")
  @ApiOperation({
    summary: "Value the lots of a bond-linked security on a day",
    description:
      "The open lots on `asOf` (default today), each with its valuation, and " +
      "the lot totals. A total is null unless every lot has the figure. " +
      "`refusal` names why the lots cannot be derived (a split, a fractional " +
      "quantity, a removal larger than the lots held).",
  })
  @ApiQuery({ name: "asOf", required: false, example: "2027-04-15" })
  @ApiResponse({ status: 200, description: "The lots, valuations and totals" })
  @ApiResponse({
    status: 404,
    description: "Not the caller's security, or not linked to a bond",
  })
  async valuationOf(
    @Request() req,
    @Param("securityId", ParseUUIDPipe) securityId: string,
    @Query("asOf", new ParseBondAsOfPipe()) asOf?: string,
    @Query("assume", new ParseAssumePipe())
    assume?: ReadonlyMap<string, string>,
  ): Promise<SecurityValuation> {
    return this.mapBondErrors(() =>
      this.valuation.valueSecurity(
        req.user.id,
        securityId,
        asOf ?? todayYMD(),
        assume,
      ),
    );
  }

  @Get("securities/:securityId/scenarios")
  @ApiOperation({
    summary: "Value a bond-linked security under assumed benchmark values",
    description:
      "As of `asOf` (default today, never later), the open lots valued with every future period of " +
      "`benchmarkId` projected at each of 1 to 6 `values` (fractions between " +
      "-0.5 and 1.0, comma-separated). Known periods stay known. Per scenario: " +
      "the lots' maturity value and total interest with its attribution, each " +
      "null if any lot cannot be valued.",
  })
  @ApiQuery({ name: "benchmarkId", example: "<benchmark series code>" })
  @ApiQuery({ name: "values", example: "0,0.025,0.05" })
  @ApiQuery({ name: "asOf", required: false, example: "2027-04-15" })
  @ApiResponse({ status: 200, description: "One entry per assumed value" })
  @ApiResponse({
    status: 404,
    description: "Not the caller's security, or not linked to a bond",
  })
  async scenariosOf(
    @Request() req,
    @Param("securityId", ParseUUIDPipe) securityId: string,
    @Query("benchmarkId", new ParseBenchmarkIdPipe()) benchmarkId: string,
    @Query("values", new ParseScenarioValuesPipe()) values: readonly string[],
    @Query("asOf", new ParseBondAsOfPipe()) asOf?: string,
  ): Promise<BondScenarios> {
    return this.mapBondErrors(() =>
      this.valuation.scenariosOf(
        req.user.id,
        securityId,
        benchmarkId,
        values,
        asOf ?? todayYMD(),
      ),
    );
  }

  @Post("securities/:securityId/recompute")
  @ApiOperation({
    summary: "Recompute the engine prices of a bond-linked security",
    description:
      "Writes the daily prices from the first transaction to today. A manual " +
      "price on a day is never overwritten; provider and transaction-derived " +
      "prices of the linked security are replaced by the engine's.",
  })
  @ApiResponse({
    status: 201,
    description: "Rows written and bond-engine rows deleted",
  })
  @ApiResponse({
    status: 404,
    description: "Not the caller's security, or not linked to a bond",
  })
  async recompute(
    @Request() req,
    @Param("securityId", ParseUUIDPipe) securityId: string,
  ): Promise<BondPriceRecompute> {
    return this.mapBondErrors(() =>
      this.prices.recomputeSecurity(req.user.id, securityId),
    );
  }

  /**
   * The stored data is missing or contradicts itself, or the input is unusable.
   * Each error's `code` selects its own `errors.bonds.<code>` message and only
   * its `params` are interpolated; the English `error.message` is for the logs
   * and never reaches the client.
   */
  private async mapBondErrors<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof BondDataNotFoundError) {
        throw new NotFoundException(bondErrorMessage(error));
      }
      if (error instanceof BondDataInconsistentError) {
        throw new UnprocessableEntityException(bondErrorMessage(error));
      }
      if (error instanceof BondEngineError) {
        throw new BadRequestException(bondErrorMessage(error));
      }
      throw error;
    }
  }
}

type BondErrorCode =
  BondEngineErrorCode | BondDataNotFoundCode | BondDataInconsistentCode;

/** The English source of each message, with the same `{{ param }}` names as the catalogue. */
export const BOND_ERROR_FALLBACKS: Readonly<
  Record<BondErrorCode, (p: BondErrorParams) => string>
> = {
  QUANTITY_INVALID: (p) =>
    `The quantity must be a positive whole number of bonds: ${p.quantity}`,
  DATE_INVALID: (p) =>
    `The purchase date (${p.purchaseDate}) and the valuation date (${p.asOf}) must be valid YYYY-MM-DD dates`,
  AS_OF_BEFORE_PURCHASE: (p) =>
    `The valuation date ${p.asOf} is before the purchase date ${p.purchaseDate}`,
  BENCHMARK_NOT_READ: (p) =>
    `Series ${p.series} does not read the benchmark ${p.benchmarkId}`,
  DECIMAL_INVALID: (p) =>
    `A stored or supplied value is not a valid decimal: ${p.field} = ${p.value}`,
  INSTRUMENT_NOT_FOUND: (p) =>
    `No bond instrument is stored for ${p.country} ${p.issuer} ${p.series}`,
  INSTRUMENT_ID_NOT_FOUND: (p) =>
    `No bond instrument is stored with id ${p.id}`,
  TERMS_NOT_FOUND: (p) => `No terms version is stored for series ${p.series}`,
  TERMS_VERSION_NOT_FOUND: (p) =>
    `Terms version ${p.version} is not stored for series ${p.series}`,
  TERMS_MISMATCH: (p) =>
    `Terms version ${p.version} of series ${p.series} describe ${p.claimedSeries} in ${p.claimedCurrency}, but the instrument is ${p.storedSeries} in ${p.storedCurrency}`,
};

function bondErrorMessage(error: {
  code: BondErrorCode;
  params: BondErrorParams;
}): string {
  return tr(
    `errors.bonds.${error.code}`,
    BOND_ERROR_FALLBACKS[error.code](error.params),
    { ...error.params },
  );
}
