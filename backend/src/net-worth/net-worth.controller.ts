import {
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  Request,
  BadRequestException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { tr } from "../i18n/translate";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import { assertStringParam } from "../common/query-param-utils";
import { NetWorthService, JointNetWorthScope } from "./net-worth.service";
import { PortfolioPeriodResultService } from "./portfolio-period-result.service";
import { PortfolioPeriodResultsBatchService } from "./portfolio-period-results-batch.service";
import {
  PORTFOLIO_PERIOD_PRESETS,
  PortfolioPeriodPreset,
  isPortfolioPeriodPreset,
} from "./portfolio-period-presets.util";
import {
  AllowDelegate,
  DelegateRequiresSection,
} from "../delegation/decorators/delegate-access.decorator";
import { DelegationService } from "../delegation/delegation.service";
import { JointAccountsService } from "../delegation/joint-accounts.service";

// A UUID that cannot match any real account: forces a naturally-empty,
// correctly-shaped result for an acting delegate with no readable accounts
// (instead of passing undefined, which the service treats as "all").
const NO_READABLE_ACCOUNT = "00000000-0000-0000-0000-000000000000";

@ApiTags("Net Worth")
@Controller("net-worth")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class NetWorthController {
  constructor(
    private readonly netWorthService: NetWorthService,
    private readonly periodResult: PortfolioPeriodResultService,
    private readonly periodResults: PortfolioPeriodResultsBatchService,
    private readonly delegationService: DelegationService,
    private readonly jointAccounts: JointAccountsService,
  ) {}

  /**
   * The caller's joint accounts minus their net-worth exclusions -- the N1
   * scope for native net worth. Undefined while acting (the delegate sees
   * the owner's own-context numbers) and when the caller has none, which
   * keeps those paths byte-identical.
   */
  private async jointScopeFor(req: {
    user: { id: string; realUserId?: string; isActing?: boolean };
  }): Promise<JointNetWorthScope | undefined> {
    if (req.user.isActing) return undefined;
    const realUserId = req.user.realUserId ?? req.user.id;
    const [grants, exclusions] = await Promise.all([
      this.jointAccounts.jointGrantsFor(realUserId),
      this.jointAccounts.getNetWorthExclusions(realUserId),
    ]);
    const accounts = [...grants.entries()]
      .filter(([accountId]) => !exclusions.has(accountId))
      .map(([accountId, g]) => ({ accountId, ownerUserId: g.ownerUserId }));
    return accounts.length > 0 ? { accounts } : undefined;
  }

  /**
   * The `accountIds` query parameter as a checked list of UUIDs.
   *
   * A malformed id is a caller error, not a filter to apply loosely: passing it
   * through would widen or narrow a scope by accident.
   */
  private parseAccountIds(value?: string): string[] | undefined {
    const ids = value ? value.split(",").filter(Boolean) : undefined;
    if (!ids) return undefined;
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const id of ids) {
      if (!uuidRegex.test(id))
        throw new BadRequestException(
          tr(
            "errors.netWorth.invalidAccountIds",
            "accountIds must be comma-separated UUIDs",
          ),
        );
    }
    return ids;
  }

  /**
   * For an acting delegate, restrict the account-id filter to the accounts
   * they were granted READ on (intersecting any explicit request). Returns
   * the original ids unchanged for non-delegate requests so owner behaviour
   * (undefined = all accounts) is preserved.
   */
  private async scopeIds(
    req: { user: { isActing?: boolean; delegationId?: string } },
    ids?: string[],
  ): Promise<string[] | undefined> {
    if (!req.user.isActing || !req.user.delegationId) return ids;
    const readable = new Set(
      await this.delegationService.readableAccountIds(req.user.delegationId),
    );
    const eff =
      ids && ids.length > 0
        ? ids.filter((i) => readable.has(i))
        : [...readable];
    return eff.length > 0 ? eff : [NO_READABLE_ACCOUNT];
  }

  @Get("monthly")
  @ApiOperation({ summary: "Get monthly net worth data" })
  @ApiQuery({ name: "startDate", required: false, example: "2023-01-01" })
  @ApiQuery({ name: "endDate", required: false, example: "2024-12-31" })
  @ApiResponse({ status: 200, description: "Monthly net worth data" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getMonthlyNetWorth(
    @Request() req,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (startDate && !dateRegex.test(startDate))
      throw new BadRequestException(
        tr("errors.netWorth.invalidStartDate", "startDate must be YYYY-MM-DD"),
      );
    if (endDate && !dateRegex.test(endDate))
      throw new BadRequestException(
        tr("errors.netWorth.invalidEndDate", "endDate must be YYYY-MM-DD"),
      );
    return this.netWorthService.getMonthlyNetWorth(
      req.user.id,
      startDate,
      endDate,
      await this.jointScopeFor(req),
    );
  }

  @Get("investments-monthly")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({ summary: "Get monthly investment portfolio value" })
  @ApiQuery({ name: "startDate", required: false, example: "2023-01-01" })
  @ApiQuery({ name: "endDate", required: false, example: "2024-12-31" })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to filter by (will include linked pairs)",
  })
  @ApiQuery({
    name: "displayCurrency",
    required: false,
    description:
      "Currency code to display values in (defaults to user preference)",
  })
  @ApiResponse({ status: 200, description: "Monthly investment value data" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getMonthlyInvestments(
    @Request() req,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("accountIds") accountIds?: string,
    @Query("displayCurrency") displayCurrency?: string,
  ) {
    const sd = assertStringParam(startDate, "startDate");
    const ed = assertStringParam(endDate, "endDate");
    const aIds = assertStringParam(accountIds, "accountIds");
    const curr = assertStringParam(displayCurrency, "displayCurrency");
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (sd && !dateRegex.test(sd))
      throw new BadRequestException(
        tr("errors.netWorth.invalidStartDate", "startDate must be YYYY-MM-DD"),
      );
    if (ed && !dateRegex.test(ed))
      throw new BadRequestException(
        tr("errors.netWorth.invalidEndDate", "endDate must be YYYY-MM-DD"),
      );
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const ids = aIds ? aIds.split(",").filter(Boolean) : undefined;
    if (ids) {
      for (const id of ids) {
        if (!uuidRegex.test(id))
          throw new BadRequestException(
            tr(
              "errors.netWorth.invalidAccountIds",
              "accountIds must be comma-separated UUIDs",
            ),
          );
      }
    }
    const safeCurrency = curr ? curr.slice(0, 3).toUpperCase() : undefined;
    return this.netWorthService.getMonthlyInvestments(
      req.user.id,
      sd,
      ed,
      await this.scopeIds(req, ids),
      safeCurrency,
    );
  }

  @Get("investments-daily")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({ summary: "Get daily investment portfolio value" })
  @ApiQuery({ name: "startDate", required: false, example: "2025-01-01" })
  @ApiQuery({ name: "endDate", required: false, example: "2025-03-04" })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to filter by (will include linked pairs)",
  })
  @ApiQuery({
    name: "displayCurrency",
    required: false,
    description:
      "Currency code to display values in (defaults to user preference)",
  })
  @ApiResponse({ status: 200, description: "Daily investment value data" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getDailyInvestments(
    @Request() req,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("accountIds") accountIds?: string,
    @Query("displayCurrency") displayCurrency?: string,
  ) {
    const sd = assertStringParam(startDate, "startDate");
    const ed = assertStringParam(endDate, "endDate");
    const aIds = assertStringParam(accountIds, "accountIds");
    const curr = assertStringParam(displayCurrency, "displayCurrency");
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (sd && !dateRegex.test(sd))
      throw new BadRequestException(
        tr("errors.netWorth.invalidStartDate", "startDate must be YYYY-MM-DD"),
      );
    if (ed && !dateRegex.test(ed))
      throw new BadRequestException(
        tr("errors.netWorth.invalidEndDate", "endDate must be YYYY-MM-DD"),
      );
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const ids = aIds ? aIds.split(",").filter(Boolean) : undefined;
    if (ids) {
      for (const id of ids) {
        if (!uuidRegex.test(id))
          throw new BadRequestException(
            tr(
              "errors.netWorth.invalidAccountIds",
              "accountIds must be comma-separated UUIDs",
            ),
          );
      }
    }
    const safeCurrency = curr ? curr.slice(0, 3).toUpperCase() : undefined;
    return this.netWorthService.getDailyInvestments(
      req.user.id,
      sd,
      ed,
      await this.scopeIds(req, ids),
      safeCurrency,
    );
  }

  @Get("investments-period-result")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({
    summary: "What the portfolio did over a period, net of deposits",
    description:
      "Three separate figures over the same series the chart draws: valueChange (last close minus first), netExternalFlows (cash that crossed the scope's boundary after the baseline, each day converted at its own date) and investmentResult (the difference). returnPercent is the result over the starting value, method 'simple'. Each is null with a named reason when a component is unknown; see docs/specs/portfolio-period-result.md.",
  })
  @ApiQuery({
    name: "period",
    required: false,
    description: `A preset the server resolves the window for (${PORTFOLIO_PERIOD_PRESETS.join(", ")}), from the same arithmetic the batch route uses. Supplying it replaces startDate and baselineDate, which are then ignored.`,
  })
  @ApiQuery({
    name: "startDate",
    required: false,
    description: "Required unless period is given.",
    example: "2026-01-02",
  })
  @ApiQuery({ name: "endDate", required: false, example: "2026-09-17" })
  @ApiQuery({
    name: "baselineDate",
    required: false,
    description:
      "The close the period is measured from, when that is earlier than startDate (the 1d / 1w / mtd ranges report against the previous trading day's close). Flows are counted strictly after it.",
  })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to filter by (will include linked pairs)",
  })
  @ApiQuery({
    name: "displayCurrency",
    required: false,
    description:
      "Currency code to display values in (defaults to user preference)",
  })
  @ApiResponse({ status: 200, description: "The period's result" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getPeriodResult(
    @Request() req,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("baselineDate") baselineDate?: string,
    @Query("accountIds") accountIds?: string,
    @Query("displayCurrency") displayCurrency?: string,
    @Query("period") period?: string,
  ) {
    const sd = assertStringParam(startDate, "startDate");
    const ed = assertStringParam(endDate, "endDate");
    const bd = assertStringParam(baselineDate, "baselineDate");
    const aIds = assertStringParam(accountIds, "accountIds");
    const curr = assertStringParam(displayCurrency, "displayCurrency");
    const preset = assertStringParam(period, "period");
    if (preset && !isPortfolioPeriodPreset(preset))
      throw new BadRequestException(
        tr(
          "errors.netWorth.invalidPeriod",
          "period must be one of the period presets",
        ),
      );
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!preset && (!sd || !dateRegex.test(sd)))
      throw new BadRequestException(
        tr("errors.netWorth.invalidStartDate", "startDate must be YYYY-MM-DD"),
      );
    if (ed && !dateRegex.test(ed))
      throw new BadRequestException(
        tr("errors.netWorth.invalidEndDate", "endDate must be YYYY-MM-DD"),
      );
    if (bd && !dateRegex.test(bd))
      throw new BadRequestException(
        tr(
          "errors.netWorth.invalidBaselineDate",
          "baselineDate must be YYYY-MM-DD",
        ),
      );
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const ids = aIds ? aIds.split(",").filter(Boolean) : undefined;
    if (ids) {
      for (const id of ids) {
        if (!uuidRegex.test(id))
          throw new BadRequestException(
            tr(
              "errors.netWorth.invalidAccountIds",
              "accountIds must be comma-separated UUIDs",
            ),
          );
      }
    }
    const safeCurrency = curr ? curr.slice(0, 3).toUpperCase() : undefined;
    const scopeIds = await this.scopeIds(req, ids);
    // A preset names the whole window, so the dates beside it are not a second
    // opinion to reconcile: the server draws it from the preset alone.
    return this.periodResult.getPeriodResult(
      req.user.id,
      isPortfolioPeriodPreset(preset ?? "")
        ? {
            period: preset as PortfolioPeriodPreset,
            endDate: ed,
            accountIds: scopeIds,
            displayCurrency: safeCurrency,
          }
        : {
            startDate: sd as string,
            endDate: ed,
            baselineDate: bd,
            accountIds: scopeIds,
            displayCurrency: safeCurrency,
          },
    );
  }

  @Get("investments-period-results")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({
    summary: "What the portfolio did over each trailing period",
    description:
      "The same measure as investments-period-result, answered for several trailing windows at once (1d, 1w, 1m, 3m, ytd, 1y) from ONE valuation of the widest of them. Each entry is the figures that route would have returned for that window; a window the value series does not reach back to is null with the reason noValueSeries. See docs/specs/portfolio-period-result.md.",
  })
  @ApiQuery({
    name: "periods",
    required: false,
    description: `Comma-separated presets; every one when omitted (${PORTFOLIO_PERIOD_PRESETS.join(", ")})`,
  })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to filter by (will include linked pairs)",
  })
  @ApiQuery({
    name: "displayCurrency",
    required: false,
    description:
      "Currency code to display values in (defaults to user preference)",
  })
  @ApiResponse({ status: 200, description: "One result per period asked for" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getPeriodResults(
    @Request() req,
    @Query("periods") periods?: string,
    @Query("accountIds") accountIds?: string,
    @Query("displayCurrency") displayCurrency?: string,
  ) {
    const raw = assertStringParam(periods, "periods");
    const aIds = assertStringParam(accountIds, "accountIds");
    const curr = assertStringParam(displayCurrency, "displayCurrency");
    // A bounded, closed set: the windows are the server's own arithmetic, so
    // an unknown name is a caller error rather than a window to invent.
    const presets: PortfolioPeriodPreset[] = [];
    for (const name of raw ? raw.split(",").filter(Boolean) : []) {
      if (!isPortfolioPeriodPreset(name))
        throw new BadRequestException(
          tr(
            "errors.netWorth.invalidPeriods",
            "periods must be comma-separated period presets",
          ),
        );
      presets.push(name);
    }
    const ids = this.parseAccountIds(aIds);
    const safeCurrency = curr ? curr.slice(0, 3).toUpperCase() : undefined;
    return this.periodResults.getPeriodResults(req.user.id, {
      periods: presets,
      accountIds: await this.scopeIds(req, ids),
      displayCurrency: safeCurrency,
    });
  }

  @Get("investments-first-priced-day")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({
    summary:
      "First day on or after a date on which any held security has a price",
    description:
      "A trading day for this portfolio, as opposed to a calendar day. The daily series values every calendar day from the last close at or before it, so it cannot distinguish a market holiday from a flat session; this can. Returns date: null when the scope holds nothing priced.",
  })
  @ApiQuery({ name: "onOrAfter", required: true, example: "2026-01-01" })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description: "Comma-separated account IDs to filter by",
  })
  @ApiResponse({ status: 200, description: "First priced day, or null" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getFirstPricedDay(
    @Request() req,
    @Query("onOrAfter") onOrAfter?: string,
    @Query("accountIds") accountIds?: string,
  ): Promise<{ date: string | null }> {
    const from = assertStringParam(onOrAfter, "onOrAfter");
    const aIds = assertStringParam(accountIds, "accountIds");
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      throw new BadRequestException(
        tr("errors.netWorth.invalidStartDate", "onOrAfter must be YYYY-MM-DD"),
      );
    }
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const ids = aIds ? aIds.split(",").filter(Boolean) : undefined;
    if (ids) {
      for (const id of ids) {
        if (!uuidRegex.test(id))
          throw new BadRequestException(
            tr(
              "errors.netWorth.invalidAccountIds",
              "accountIds must be comma-separated UUIDs",
            ),
          );
      }
    }
    return this.netWorthService.getFirstPricedDay(
      req.user.id,
      from,
      await this.scopeIds(req, ids),
    );
  }

  @Get("investments-breakdown")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({
    summary: "Get portfolio value over time broken down by security",
  })
  @ApiQuery({
    name: "granularity",
    required: true,
    description: "'daily' or 'monthly' point resolution",
  })
  @ApiQuery({ name: "startDate", required: false, example: "2024-01-01" })
  @ApiQuery({ name: "endDate", required: false, example: "2024-12-31" })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to filter by (will include linked pairs)",
  })
  @ApiQuery({
    name: "displayCurrency",
    required: false,
    description:
      "Currency code to display values in (defaults to user preference)",
  })
  @ApiResponse({
    status: 200,
    description: "Per-security portfolio value series",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getInvestmentBreakdown(
    @Request() req,
    @Query("granularity") granularity?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("accountIds") accountIds?: string,
    @Query("displayCurrency") displayCurrency?: string,
  ) {
    const gran = assertStringParam(granularity, "granularity");
    if (gran !== "daily" && gran !== "monthly") {
      throw new BadRequestException(
        tr(
          "errors.netWorth.invalidGranularity",
          "granularity must be 'daily' or 'monthly'",
        ),
      );
    }
    const sd = assertStringParam(startDate, "startDate");
    const ed = assertStringParam(endDate, "endDate");
    const aIds = assertStringParam(accountIds, "accountIds");
    const curr = assertStringParam(displayCurrency, "displayCurrency");
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (sd && !dateRegex.test(sd))
      throw new BadRequestException(
        tr("errors.netWorth.invalidStartDate", "startDate must be YYYY-MM-DD"),
      );
    if (ed && !dateRegex.test(ed))
      throw new BadRequestException(
        tr("errors.netWorth.invalidEndDate", "endDate must be YYYY-MM-DD"),
      );
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const ids = aIds ? aIds.split(",").filter(Boolean) : undefined;
    if (ids) {
      for (const id of ids) {
        if (!uuidRegex.test(id))
          throw new BadRequestException(
            tr(
              "errors.netWorth.invalidAccountIds",
              "accountIds must be comma-separated UUIDs",
            ),
          );
      }
    }
    const safeCurrency = curr ? curr.slice(0, 3).toUpperCase() : undefined;
    return this.netWorthService.getInvestmentBreakdown(req.user.id, {
      granularity: gran,
      startDate: sd,
      endDate: ed,
      accountIds: await this.scopeIds(req, ids),
      displayCurrency: safeCurrency,
    });
  }

  @Post("recalculate")
  @ApiOperation({ summary: "Trigger full net worth recalculation" })
  @ApiResponse({ status: 201, description: "Recalculation triggered" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async recalculate(@Request() req) {
    await this.netWorthService.recalculateAllAccounts(req.user.id);
    return { success: true };
  }
}
