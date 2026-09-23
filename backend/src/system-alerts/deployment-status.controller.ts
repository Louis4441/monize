import { Controller, Get, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import {
  DeploymentStatus,
  SystemAlertMonitorService,
} from "./system-alert-monitor.service";

/**
 * Deployment configuration an administrator has to fix, for the admin banner.
 *
 * Admin-only because nobody else can act on it, and because it describes the
 * server's own security posture. It answers with reason codes; the secret, or
 * anything computed from it, never leaves the server.
 */
@ApiTags("Admin")
@ApiBearerAuth()
@Controller("admin/deployment-status")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles("admin")
export class DeploymentStatusController {
  constructor(private readonly monitor: SystemAlertMonitorService) {}

  @Get()
  @ApiOperation({
    summary:
      "Deployment configuration an administrator should fix, e.g. a weak JWT_SECRET (admin only)",
  })
  getStatus(): DeploymentStatus {
    return this.monitor.getDeploymentStatus();
  }
}
