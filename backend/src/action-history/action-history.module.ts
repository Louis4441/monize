import { Module } from "@nestjs/common";
import { ActionHistoryService } from "./action-history.service";
import { ActionHistoryController } from "./action-history.controller";

@Module({
  providers: [ActionHistoryService],
  controllers: [ActionHistoryController],
  exports: [ActionHistoryService],
})
export class ActionHistoryModule {}
