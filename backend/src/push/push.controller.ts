import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { PushConfigService, PublicPushConfig } from "./push-config.service";
import {
  PushDeviceDto,
  PushSubscriptionService,
  PushTestResult,
} from "./push-subscription.service";
import { CreatePushSubscriptionDto } from "./dto/create-push-subscription.dto";

/**
 * A user's own push devices.
 *
 * Every route derives its tenant from `req.user.id`. There is no route here
 * that names another user, and no administrator route that reaches these: an
 * administrator configures the instance's push identity and never sends to, or
 * lists, somebody else's devices (discussion #1291).
 */
@ApiTags("Push")
@Controller("push")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class PushController {
  constructor(
    private readonly pushConfig: PushConfigService,
    private readonly subscriptions: PushSubscriptionService,
  ) {}

  @Get("config")
  @ApiOperation({
    summary: "Whether push is available here, and the instance's public key",
  })
  getConfig(): Promise<PublicPushConfig> {
    return this.pushConfig.getPublicConfig();
  }

  @Get("subscriptions")
  @ApiOperation({ summary: "List the current user's push devices" })
  list(@Request() req): Promise<PushDeviceDto[]> {
    return this.subscriptions.listForUser(req.user.id);
  }

  /**
   * Demo-restricted because every demo visitor shares one account: a
   * subscription registered by one visitor would receive the test notification
   * another visitor triggered.
   */
  @Post("subscriptions")
  @HttpCode(HttpStatus.CREATED)
  @DemoRestricted()
  @ApiOperation({ summary: "Register this browser for push notifications" })
  subscribe(
    @Request() req,
    @Body() dto: CreatePushSubscriptionDto,
    @Headers("user-agent") userAgent?: string,
  ): Promise<PushDeviceDto> {
    return this.subscriptions.subscribe(req.user.id, dto, userAgent ?? null);
  }

  @Delete("subscriptions/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove one of the current user's push devices" })
  remove(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.subscriptions.remove(req.user.id, id);
  }

  /** Demo-restricted for the shared-account reason given on `subscribe`. */
  @Post("test")
  @DemoRestricted()
  @ApiOperation({
    summary: "Send the current user a test notification on their own devices",
  })
  test(@Request() req): Promise<PushTestResult> {
    return this.subscriptions.sendTest(req.user.id);
  }
}
