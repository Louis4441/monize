import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Request,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { OwnerOnly } from "../delegation/decorators/delegate-access.decorator";
import { TransactionRulesService } from "./transaction-rules.service";
import { CreateTransactionRuleDto } from "./dto/create-transaction-rule.dto";
import { UpdateTransactionRuleDto } from "./dto/update-transaction-rule.dto";
import { ReorderTransactionRulesDto } from "./dto/reorder-transaction-rules.dto";
import { SetTransactionRuleEnabledDto } from "./dto/set-transaction-rule-enabled.dto";
import { TransactionRuleResponseDto } from "./dto/transaction-rule-response.dto";

/**
 * A user's own rules. Owner-only: `@OwnerOnly()` makes `AccountDelegateGuard`
 * refuse a delegate ("acting as") session on every route here, which is the
 * fail-closed default made explicit (design section 3, decision 8). `userId`
 * is the JWT's, never a param or a body field.
 */
@ApiTags("Transaction Rules")
@Controller("transaction-rules")
@UseGuards(AuthGuard("jwt"))
@OwnerOnly()
@ApiBearerAuth()
export class TransactionRulesController {
  constructor(private readonly rulesService: TransactionRulesService) {}

  @Get()
  @ApiOperation({ summary: "List my rules in evaluation order" })
  @ApiResponse({ status: 200, type: [TransactionRuleResponseDto] })
  findAll(@Request() req: { user: { id: string } }) {
    return this.rulesService.list(req.user.id);
  }

  @Post()
  @ApiOperation({ summary: "Create a rule at the end of the list" })
  @ApiResponse({ status: 201, type: TransactionRuleResponseDto })
  @ApiResponse({ status: 400, description: "Invalid definition or limit hit" })
  create(
    @Request() req: { user: { id: string } },
    @Body() dto: CreateTransactionRuleDto,
  ) {
    return this.rulesService.create(req.user.id, dto);
  }

  // Registered before `:id` so the literal "reorder" segment is not captured
  // by ParseUUIDPipe.
  @Put("reorder")
  @ApiOperation({ summary: "Set the evaluation order of all my rules" })
  @ApiResponse({ status: 200, type: [TransactionRuleResponseDto] })
  @ApiResponse({ status: 409, description: "The list of rules changed" })
  reorder(
    @Request() req: { user: { id: string } },
    @Body() dto: ReorderTransactionRulesDto,
  ) {
    return this.rulesService.reorder(req.user.id, dto.ids);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a rule" })
  @ApiResponse({ status: 200, type: TransactionRuleResponseDto })
  @ApiResponse({ status: 404, description: "Rule not found" })
  findOne(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.rulesService.get(req.user.id, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a rule (compare-and-swap on revision)" })
  @ApiResponse({ status: 200, type: TransactionRuleResponseDto })
  @ApiResponse({ status: 404, description: "Rule not found" })
  @ApiResponse({ status: 409, description: "Stale revision" })
  update(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateTransactionRuleDto,
  ) {
    return this.rulesService.update(req.user.id, id, dto);
  }

  @Patch(":id/enabled")
  @ApiOperation({ summary: "Enable or disable a rule" })
  @ApiResponse({ status: 200, type: TransactionRuleResponseDto })
  @ApiResponse({ status: 404, description: "Rule not found" })
  setEnabled(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SetTransactionRuleEnabledDto,
  ) {
    return this.rulesService.setEnabled(req.user.id, id, dto.enabled);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete a rule and close the gap in the order" })
  @ApiResponse({ status: 204, description: "Rule deleted" })
  @ApiResponse({ status: 404, description: "Rule not found" })
  remove(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.rulesService.remove(req.user.id, id);
  }
}
