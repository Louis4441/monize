import { NotificationType } from "../notification-center/entities/notification.entity";
import { NOTIFICATION_EMAIL_MESSAGES } from "./notification-email-messages";

type Copy = { title: string; message: string };
type Data = Record<string, unknown>;
type Key = keyof typeof NOTIFICATION_EMAIL_MESSAGES;

/** What the bond copy needs from `composeLocalizedNotificationCopy`: its translator and the recipient's formatters. */
export interface BondCopyContext {
  text: (key: Key, args?: Data) => string;
  number: (value: number, decimals?: number) => string;
  money: (value: number, currency: string) => string;
  percent: (value: number, decimals?: number) => string;
  date: (value: unknown) => string | null;
  locale: string;
}

const REASONS: Readonly<Record<string, Key>> = {
  RATE_UNKNOWN: "bond.reason.RATE_UNKNOWN",
  TERMS_INCOMPLETE: "bond.reason.TERMS_INCOMPLETE",
  PURCHASE_OUTSIDE_SALE_WINDOW: "bond.reason.PURCHASE_OUTSIDE_SALE_WINDOW",
};

const isText = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

/** A decimal string the engine wrote ("51.00"), as a number for display only. */
function decimal(value: unknown): number | null {
  if (!isText(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Whole bonds. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/** `YYYY-MM` as a month and year, a day as a date, anything else as written. */
function observationLabel(value: string, ctx: BondCopyContext): string {
  if (/^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split("-").map(Number);
    return new Intl.DateTimeFormat(ctx.locale, {
      year: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, 1)));
  }
  return ctx.date(value) ?? value;
}

/** The sentence about a payout: the figure, or that it is not known yet and why. */
function payoutSentence(data: Data, currency: string, ctx: BondCopyContext) {
  const payout = decimal(data.payout);
  if (payout !== null) {
    return ctx.text("bond.payoutKnown", {
      payout: ctx.money(payout, currency),
    });
  }
  const code = typeof data.missing === "string" ? data.missing : "";
  return ctx.text("bond.payoutUnknown", {
    reason: ctx.text(REASONS[code] ?? "bond.reason.other"),
  });
}

function causeText(cause: unknown, ctx: BondCopyContext): string | null {
  if (typeof cause !== "object" || cause === null) return null;
  const c = cause as Data;
  switch (c.code) {
    case "OBSERVATION_MISSING":
      if (!isText(c.benchmarkId) || !isText(c.observation)) return null;
      return isText(c.publisher)
        ? ctx.text("bond.cause.observation", {
            observation: observationLabel(c.observation, ctx),
            benchmark: c.benchmarkId,
            publisher: c.publisher,
          })
        : ctx.text("bond.cause.observationNoPublisher", {
            observation: observationLabel(c.observation, ctx),
            benchmark: c.benchmarkId,
          });
    case "TERMS_INCOMPLETE":
      return isText(c.seriesCode)
        ? ctx.text("bond.cause.terms", { series: c.seriesCode })
        : null;
    case "PURCHASE_OUTSIDE_SALE_WINDOW": {
      const purchase = ctx.date(c.purchaseDate);
      const from = ctx.date(c.from);
      const to = ctx.date(c.to);
      if (!isText(c.seriesCode) || !purchase || !from || !to) return null;
      return ctx.text("bond.cause.purchase", {
        series: c.seriesCode,
        date: purchase,
        from,
        to,
      });
    }
    case "LOTS_UNDERIVABLE":
      return isText(c.refusalCode)
        ? ctx.text("bond.cause.lots", { code: c.refusalCode })
        : null;
    default:
      return null;
  }
}

/**
 * The recipient-locale copy of a bond notification, composed from `data` alone.
 * An amount that is `null` says it is not known yet and why; a row without the
 * facts its copy needs returns null and keeps its stored English whole.
 */
export function composeBondCopy(
  type: NotificationType,
  data: Data,
  ctx: BondCopyContext,
): Copy | null {
  const currency = isText(data.currency) ? data.currency : null;
  const series = isText(data.seriesCode) ? data.seriesCode : null;
  const quantity = count(data.quantity);
  switch (type) {
    case NotificationType.BOND_MATURITY_SOON:
    case NotificationType.BOND_REDEMPTION_UNBOOKED: {
      const date = ctx.date(data.maturityDate);
      if (!series || !currency || quantity === null || !date) return null;
      const args = {
        series,
        date,
        quantity: ctx.number(quantity, 0),
        payout: payoutSentence(data, currency, ctx),
      };
      return type === NotificationType.BOND_MATURITY_SOON
        ? {
            title: ctx.text("bond.maturitySoonTitle", args),
            message: ctx.text("bond.maturitySoonMessage", args),
          }
        : {
            title: ctx.text("bond.unbookedTitle", args),
            message: ctx.text("bond.unbookedMessage", args),
          };
    }
    case NotificationType.BOND_INTEREST_PAYMENT: {
      const date = ctx.date(data.paymentDate);
      if (!series || !currency || quantity === null || !date) return null;
      // A null amount is a valid producer state (a rate not published yet); a
      // missing key is an older row and is not proof of that.
      if (!("amount" in data)) return null;
      const amount = decimal(data.amount);
      if (data.amount !== null && amount === null) return null;
      const args = { series, date, quantity: ctx.number(quantity, 0) };
      return {
        title: ctx.text("bond.interestTitle", args),
        message:
          amount === null
            ? ctx.text("bond.interestMessageUnknown", args)
            : ctx.text("bond.interestMessage", {
                ...args,
                amount: ctx.money(amount, currency),
              }),
      };
    }
    case NotificationType.BOND_RATE_RESET: {
      const date = ctx.date(data.periodStart);
      const rate = decimal(data.annualRate);
      const period = count(data.periodIndex);
      if (!series || !date || rate === null || period === null) return null;
      return {
        title: ctx.text("bond.rateResetTitle", { series }),
        message: ctx.text("bond.rateResetMessage", {
          series,
          date,
          period: ctx.number(period, 0),
          rate: ctx.percent(rate * 100, 2),
        }),
      };
    }
    case NotificationType.BOND_BENCHMARK_PUBLISHED: {
      const more = count(data.affectedMore);
      if (
        !isText(data.benchmarkId) ||
        !isText(data.publisher) ||
        !isText(data.observation) ||
        !isText(data.value) ||
        !Array.isArray(data.affected) ||
        more === null
      )
        return null;
      const names = data.affected.flatMap((entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        isText((entry as Data).seriesCode)
          ? [(entry as Data).seriesCode as string]
          : [],
      );
      if (names.length === 0) return null;
      const args = {
        benchmark: data.benchmarkId,
        publisher: data.publisher,
        observation: observationLabel(data.observation, ctx),
        value: data.value,
        series: names.join(", "),
        more: ctx.number(more, 0),
      };
      return {
        title: ctx.text("bond.benchmarkTitle", args),
        message: ctx.text(
          more > 0 ? "bond.benchmarkMessageMore" : "bond.benchmarkMessage",
          args,
        ),
      };
    }
    case NotificationType.BOND_DATA_MISSING: {
      if (!Array.isArray(data.causes) || data.causes.length === 0) return null;
      const parts = data.causes.map((cause: unknown) => causeText(cause, ctx));
      if (parts.some((part) => part === null)) return null;
      return {
        title: ctx.text("bond.missingTitle"),
        message: ctx.text("bond.missingMessage", { causes: parts.join("; ") }),
      };
    }
    default:
      return null;
  }
}
