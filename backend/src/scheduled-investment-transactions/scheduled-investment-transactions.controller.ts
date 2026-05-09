import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { ScheduledInvestmentTransactionsService } from "./scheduled-investment-transactions.service";
import { CreateScheduledInvestmentTransactionDto } from "./dto/create-scheduled-investment-transaction.dto";
import { UpdateScheduledInvestmentTransactionDto } from "./dto/update-scheduled-investment-transaction.dto";
import { PostScheduledInvestmentTransactionDto } from "./dto/post-scheduled-investment-transaction.dto";

@ApiTags("Scheduled Investment Transactions")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("scheduled-investment-transactions")
export class ScheduledInvestmentTransactionsController {
  constructor(
    private readonly service: ScheduledInvestmentTransactionsService,
  ) {}

  @Post()
  create(@Request() req, @Body() dto: CreateScheduledInvestmentTransactionDto) {
    return this.service.create(req.user.id, dto);
  }

  @Get()
  findAll(@Request() req) {
    return this.service.findAll(req.user.id);
  }

  @Get("upcoming")
  findUpcoming(
    @Request() req,
    @Query("days", new ParseIntPipe({ optional: true })) days?: number,
  ) {
    return this.service.findUpcoming(req.user.id, days ?? 30);
  }

  @Get(":id")
  findOne(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.service.findOne(req.user.id, id);
  }

  @Patch(":id")
  update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateScheduledInvestmentTransactionDto,
  ) {
    return this.service.update(req.user.id, id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    await this.service.remove(req.user.id, id);
  }

  @Post(":id/post")
  post(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: PostScheduledInvestmentTransactionDto,
  ) {
    return this.service.post(req.user.id, id, dto);
  }

  @Post(":id/skip")
  skip(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.service.skip(req.user.id, id);
  }
}
