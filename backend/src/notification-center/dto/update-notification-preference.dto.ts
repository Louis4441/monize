import { IsBoolean } from "class-validator";

/** The one channel Phase 1 exposes for a category. */
export class UpdateNotificationPreferenceDto {
  @IsBoolean()
  email: boolean;
}
