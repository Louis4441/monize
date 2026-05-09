export type FrequencyType =
  | "ONCE"
  | "DAILY"
  | "WEEKLY"
  | "BIWEEKLY"
  | "EVERY4WEEKS"
  | "SEMIMONTHLY"
  | "MONTHLY"
  | "QUARTERLY"
  | "YEARLY";

const YMD_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseYMD(ymd: string): { y: number; m: number; d: number } {
  const match = YMD_PATTERN.exec(ymd);
  if (!match) {
    throw new Error(`Invalid YYYY-MM-DD date string: ${ymd}`);
  }
  return {
    y: Number(match[1]),
    m: Number(match[2]),
    d: Number(match[3]),
  };
}

function formatYMD(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(ymd: string, days: number): string {
  const { y, m, d } = parseYMD(ymd);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return formatYMD(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
  );
}

function addMonthsClamped(ymd: string, months: number): string {
  const { y, m, d } = parseYMD(ymd);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return formatYMD(ny, nm, nd);
}

function addYearsClamped(ymd: string, years: number): string {
  const { y, m, d } = parseYMD(ymd);
  const ny = y + years;
  const nd = Math.min(d, daysInMonth(ny, m));
  return formatYMD(ny, m, nd);
}

export function calculateNextDueDate(
  ymd: string,
  frequency: FrequencyType,
): string {
  switch (frequency) {
    case "ONCE":
      return ymd;
    case "DAILY":
      return addDays(ymd, 1);
    case "WEEKLY":
      return addDays(ymd, 7);
    case "BIWEEKLY":
      return addDays(ymd, 14);
    case "EVERY4WEEKS":
      return addDays(ymd, 28);
    case "SEMIMONTHLY": {
      const { y, m, d } = parseYMD(ymd);
      if (d <= 15) {
        return formatYMD(y, m, daysInMonth(y, m));
      }
      const total = y * 12 + m;
      const ny = Math.floor(total / 12);
      const nm = (total % 12) + 1;
      return formatYMD(ny, nm, 15);
    }
    case "MONTHLY":
      return addMonthsClamped(ymd, 1);
    case "QUARTERLY":
      return addMonthsClamped(ymd, 3);
    case "YEARLY":
      return addYearsClamped(ymd, 1);
    default:
      return ymd;
  }
}

export function ensureYMD(value: string | Date): string {
  if (typeof value === "string") {
    if (YMD_PATTERN.test(value)) return value;
    return value.split("T")[0];
  }
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, "0");
  const d = String(value.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
