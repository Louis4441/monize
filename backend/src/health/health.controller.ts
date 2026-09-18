import {
  Controller,
  Get,
  Inject,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { tr } from "../i18n/translate";
import { SkipThrottle } from "@nestjs/throttler";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { CLUSTER_MODE, ClusterMode } from "../common/cluster/cluster-mode";
import {
  PG_LISTENER,
  PgListener,
} from "../common/cluster/pg-listener.provider";

@ApiTags("Health")
@SkipThrottle()
@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @InjectDataSource()
    private dataSource: DataSource,
    @Inject(CLUSTER_MODE)
    private readonly clusterMode: ClusterMode,
    @Inject(PG_LISTENER)
    private readonly listener: PgListener | null,
  ) {}

  @Get()
  @ApiOperation({ summary: "Health check endpoint" })
  async check() {
    const dbHealthy = await this.checkDatabase();
    const busHealthy = this.checkNotificationChannel();

    return {
      status: dbHealthy && busHealthy !== false ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      checks: {
        database: dbHealthy ? "healthy" : "unhealthy",
        // Reported only in multi. In single there is no cross-replica channel,
        // and a key that is always "healthy" would invite a dashboard to watch
        // a constant.
        ...(busHealthy === null
          ? {}
          : { eventBus: busHealthy ? "healthy" : "unhealthy" }),
      },
    };
  }

  @Get("live")
  @ApiOperation({ summary: "Liveness probe - is the app running?" })
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  @ApiOperation({
    summary: "Readiness probe - is the app ready to serve traffic?",
  })
  async ready() {
    const dbHealthy = await this.checkDatabase();

    if (!dbHealthy) {
      throw new ServiceUnavailableException(
        tr("errors.common.serviceNotReady", "Service not ready"),
      );
    }

    // A replica whose notification connection is down still answers requests,
    // but it cannot be woken: an SSE stream it holds advances only on the slow
    // poll, and a relay turn answered on another replica waits out that timer.
    // Leaving the load balancer until the reconnect succeeds costs one replica
    // and hides nothing; staying in it serves a degraded conversation that
    // looks like a hung one. The reason is logged rather than returned -- the
    // body is a public probe response, and the same generic refusal covers both
    // causes.
    if (this.checkNotificationChannel() === false) {
      this.logger.warn(
        "Not ready: the notification connection is down, so this replica " +
          "cannot be woken by another. Reconnecting.",
      );
      throw new ServiceUnavailableException(
        tr("errors.common.serviceNotReady", "Service not ready"),
      );
    }

    return { status: "ok" };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.dataSource.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `null` when there is nothing to check (`single`), otherwise whether the
   * channel is live. Three states rather than a boolean, so "no cross-replica
   * channel exists" is never reported as "it is down".
   */
  private checkNotificationChannel(): boolean | null {
    if (this.clusterMode !== "multi") {
      return null;
    }
    return this.listener?.isConnected() ?? false;
  }
}
