import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";

import { EVENT_BUS, EventBus } from "../common/events/event-bus.interface";
import {
  PORTFOLIO_SUMMARY_INVALIDATION_CHANNEL,
  applyPortfolioSummaryInvalidation,
  setPortfolioSummaryBroadcast,
} from "./portfolio-summary-memo";

/**
 * The two ends of the portfolio-summary memo's cross-replica invalidation.
 *
 * The memo is process memory, so the replica that serves a write drops its own
 * entry and no other replica hears about it. Behind a load balancer with no
 * affinity the next read lands on one that did not -- and answers from a
 * valuation taken before the trade, for up to the memo's TTL. The
 * `CLUSTER_MODE=multi` E2E shard caught exactly that: a BUY entered on the
 * Investments page, and the account still reading "0 positions" afterwards
 * (issue #1409).
 *
 * So this subscribes every replica to the invalidation channel, and registers
 * the announcer the memo calls when a write invalidates it. Both ends live in
 * one provider because they are one seam: a replica that announces without
 * listening, or listens without announcing, is half a repair and impossible to
 * reason about from either file alone.
 *
 * **It is a hint, not a guarantee** -- `common/events/event-bus.interface.ts` is
 * explicit that `NOTIFY` can be lost, and this handler's response is the only
 * correct one for a hint: drop a derived cache so the next read goes back to
 * the database. A message that never arrives leaves the memo's TTL as the
 * bound, which is where this started.
 */
@Injectable()
export class PortfolioSummaryInvalidationBridge
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PortfolioSummaryInvalidationBridge.name);

  /** The subscription's own unsubscribe; `null` while not subscribed. */
  private unsubscribe: (() => void) | null = null;

  constructor(@Inject(EVENT_BUS) private readonly bus: EventBus) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe(
      PORTFOLIO_SUMMARY_INVALIDATION_CHANNEL,
      (payload) => applyPortfolioSummaryInvalidation(payload),
    );
    setPortfolioSummaryBroadcast((payload) => {
      // Not awaited, and deliberately: the seams that invalidate are
      // synchronous and have already committed, so an announcement that fails
      // costs the other replicas their TTL and this request nothing. The
      // rejection is logged here because `publish` rejects rather than
      // swallowing a down connection, and a silent catch would make a bus that
      // is never delivering look exactly like one that is.
      void this.bus
        .publish(PORTFOLIO_SUMMARY_INVALIDATION_CHANNEL, payload)
        .catch((error: unknown) => {
          this.logger.warn(
            `Could not announce a portfolio summary invalidation; other ` +
              `replicas keep their entry until it expires: ${
                error instanceof Error ? error.message : String(error)
              }`,
          );
        });
    });
  }

  onModuleDestroy(): void {
    // The announcer first: a shutdown that stops listening while still
    // announcing would publish onto a bus this process no longer reads.
    setPortfolioSummaryBroadcast(null);
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
