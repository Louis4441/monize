import { Module } from "@nestjs/common";
import { AiReviewRequestsService } from "./ai-review-requests.service";

/**
 * The AI review queue (design 6.5). It imports nothing from the rules module:
 * `TransactionRulesModule` imports this one to enqueue `request_ai_review`
 * actions, so the edge only runs one way.
 */
@Module({
  providers: [AiReviewRequestsService],
  exports: [AiReviewRequestsService],
})
export class AiReviewModule {}
