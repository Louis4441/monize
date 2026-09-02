import { IsBoolean, IsInt, IsOptional, Max, Min } from "class-validator";

import { THROTTLE_MAX_MINUTES } from "../notification-preference.service";

/**
 * A partial update to one category's preferences. Both fields are optional so a
 * surface can change the email channel and the throttle window independently;
 * the service writes only what is present and keeps the rest.
 */
export class UpdateNotificationPreferenceDto {
  @IsOptional()
  @IsBoolean()
  email?: boolean;

  /** Throttle window in minutes; 0 disables. Bounded so it cannot suppress for longer than a day. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(THROTTLE_MAX_MINUTES)
  throttleMinutes?: number;
}
