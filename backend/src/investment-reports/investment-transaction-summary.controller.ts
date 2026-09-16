import { Controller, Get, Query, Request, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { InvestmentTransactionSummaryService } from "./investment-transaction-summary.service";
import {
  InvestmentTransactionSummary,
  InvestmentTransactionSummaryQueryDto,
} from "./dto/investment-transaction-summary.dto";
import {
  AllowDelegate,
  DelegateRequiresSection,
} from "../delegation/decorators/delegate-access.decorator";

/**
 * Its own controller rather than a route on `InvestmentReportsController`:
 * that one is CRUD over saved reports and owns `GET /reports/investment/:id`,
 * which any sibling literal path would have to be declared ahead of.
 */
@ApiTags("Investment Reports")
@Controller("reports/investment-transactions")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
@DelegateRequiresSection("reports")
export class InvestmentTransactionSummaryController {
  constructor(
    private readonly summaryService: InvestmentTransactionSummaryService,
  ) {}

  @Get("summary")
  @AllowDelegate()
  @ApiOperation({
    summary:
      "Volume, count and by-action subtotals over every investment transaction matching the filter, converted into the reporting currency",
  })
  summary(
    @Request() req,
    @Query() query: InvestmentTransactionSummaryQueryDto,
  ): Promise<InvestmentTransactionSummary> {
    return this.summaryService.summarize(req.user.id, query);
  }
}
