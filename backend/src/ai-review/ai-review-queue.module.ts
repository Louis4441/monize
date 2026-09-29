import { Module, forwardRef } from "@nestjs/common";
import { AiActionBuilderModule } from "../ai/actions/ai-action-builder.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { AiReviewModule } from "./ai-review.module";
import { AiReviewRequestsController } from "./ai-review-requests.controller";
import { AiReviewWorkService } from "./ai-review-work.service";

/**
 * The AI review queue as a surface: the agents' tool logic (MCP and assistant)
 * and the review inbox's REST routes. Separate from `AiReviewModule`, which
 * stays a leaf the rules module imports to enqueue: this one reaches the
 * transactions module, and that one reaches the rules module back.
 */
@Module({
  imports: [
    AiReviewModule,
    AiActionBuilderModule,
    forwardRef(() => TransactionsModule),
  ],
  providers: [AiReviewWorkService],
  controllers: [AiReviewRequestsController],
  exports: [AiReviewWorkService],
})
export class AiReviewQueueModule {}
