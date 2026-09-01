import { IsEnum, IsIn, IsOptional } from "class-validator";
import { NotificationSeverity } from "../../notification-center/entities/notification.entity";

export const ALERT_CATEGORIES = ["system", "financial"] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

/**
 * The filter a dismiss-all command carries. The client sends its active
 * filter explicitly on the command (never inferred from which rows happen to
 * be on screen), and the server restricts the write on it -- an omitted field
 * means "no restriction on that dimension".
 */
export class DismissAlertsQueryDto {
  @IsOptional()
  @IsEnum(NotificationSeverity)
  severity?: NotificationSeverity;

  @IsOptional()
  @IsIn(ALERT_CATEGORIES)
  category?: AlertCategory;
}
