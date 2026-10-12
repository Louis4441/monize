import { Injectable, Logger } from "@nestjs/common";
import { YahooFinanceService } from "../../securities/yahoo-finance.service";
import { HistoricalPrice } from "../../securities/providers/quote-provider.interface";
import { mapWithConcurrency } from "../../common/concurrency.util";
import { todayYMD } from "../../common/date-utils";
import { isSparseRateSeries } from "../rate-gap-plan";
import {
  FxQuote,
  FxQuoteObservation,
  chooseFxQuote,
  quoteNeedsInverse,
} from "../quoted-rate.util";
import {
  FxObservation,
  FxProviderName,
  FxRateProvider,
} from "./fx-provider.interface";

/**
 * Cap on concurrent Yahoo FX quote fetches, so a refresh does not burst every
 * currency pair at once (the daily refresh runs alongside the security price
 * refresh, so the combined load on Yahoo has to stay bounded).
 */
export const FX_FETCH_CONCURRENCY = 6;

/** Yahoo's symbol for the `from -> to` rate. */
function fxSymbol(from: string, to: string): string {
  return `${from}${to}=X`;
}

/** The unique days a series carries a usable rate for. */
function observationDays(series: readonly FxObservation[]): string[] {
  return [...new Set(series.map((point) => point.date))];
}

/**
 * Exchange rates from Yahoo Finance, through `YahooFinanceService` (its
 * throttle, retry and breaker stay in front of every call).
 *
 * Yahoo cannot enumerate the currencies it quotes, so `carries` is always true
 * and it is the chain's last resort for any pair. Two rules that used to live
 * in `ExchangeRateService` are the adapter's now, so a caller on the chain
 * keeps them without knowing the provider:
 *
 * - A latest quote below 1 is checked against the reverse symbol and the one
 *   with more digits is the observation (`quoted-rate.util.ts`, issue #1604);
 *   a quote too coarse either way is answered as "no rate", never stored.
 * - A daily window is asked of the direct symbol, then the reverse when the
 *   direct answer is sparse, and the two are merged densest first; the window
 *   is "not answered" only when nothing was found and a symbol did not answer,
 *   the rule `fillRateWindow` holds today.
 *
 * Observations come back in the orientation that answered; the writer orients
 * them. A quote is dated `todayYMD()`, as the refresh dates it today, so no
 * Yahoo row changes when the service moves onto the chain. Yahoo's client
 * answers `null` for an outage and for an unknown symbol alike, so a batch is
 * "not answered" only when no symbol in it answered at all.
 */
@Injectable()
export class YahooFxProvider implements FxRateProvider {
  readonly name: FxProviderName = "yahoo";
  readonly source = "yahoo_finance";
  private readonly logger = new Logger(YahooFxProvider.name);

  constructor(private readonly yahoo: YahooFinanceService) {}

  async carries(_code: string): Promise<boolean> {
    return true;
  }

  async fetchLatest(
    base: string,
    quotes: readonly string[],
  ): Promise<ReadonlyMap<string, FxObservation> | null> {
    const date = todayYMD();
    const choices = await mapWithConcurrency(
      quotes,
      FX_FETCH_CONCURRENCY,
      (quote) => this.chooseQuote(base, quote),
    );

    const found = new Map<string, FxObservation>();
    let anySymbolAnswered = false;
    for (const [index, choice] of choices.entries()) {
      if (choice.answered) anySymbolAnswered = true;
      if (choice.observation) {
        found.set(quotes[index], { ...choice.observation, date });
      }
    }
    if (quotes.length > 0 && !anySymbolAnswered) return null;
    return found;
  }

  async fetchDailySeries(
    from: string,
    to: string,
    start: string,
    end: string,
  ): Promise<FxObservation[] | null> {
    const direct = await this.fetchWindow(from, to, start, end);
    if (
      direct !== null &&
      !isSparseRateSeries(observationDays(direct), start, end)
    ) {
      return direct;
    }

    const reverse = await this.fetchWindow(to, from, start, end);
    const directPoints = direct ?? [];
    const reversePoints = reverse ?? [];
    if (directPoints.length === 0 && reversePoints.length === 0) {
      // Both symbols, not either: "this pair has no rates in this window" is
      // only known when both answered. One of them answering `[]` while the
      // other failed is half-knowledge, and is reported as no answer.
      return direct !== null && reverse !== null ? [] : null;
    }

    // The denser answer first, the direct one on a tie; the other contributes
    // only the days the first has no bar for.
    const [primary, secondary] =
      observationDays(reversePoints).length >
      observationDays(directPoints).length
        ? [reversePoints, directPoints]
        : [directPoints, reversePoints];
    const covered = new Set(observationDays(primary));
    return [
      ...primary,
      ...secondary.filter((point) => !covered.has(point.date)),
    ];
  }

  async fetchLive(from: string, to: string): Promise<FxObservation | null> {
    const { observation } = await this.chooseQuote(from, to);
    return observation ? { ...observation, date: todayYMD() } : null;
  }

  /**
   * One pair's latest quote: the direct symbol, then the reverse when the
   * direct quote is absent or below 1, and `chooseFxQuote` between them.
   * `answered` is whether either symbol answered at all, with or without a
   * usable rate.
   */
  private async chooseQuote(
    from: string,
    to: string,
  ): Promise<{ observation: FxQuoteObservation | null; answered: boolean }> {
    const directQuote = await this.fetchRate(from, to);
    const direct: FxQuote = { from, to, rate: directQuote.rate };
    const reverseQuote = quoteNeedsInverse(direct.rate)
      ? await this.fetchRate(to, from)
      : null;
    const reverse: FxQuote | null = reverseQuote
      ? { from: to, to: from, rate: reverseQuote.rate }
      : null;

    const choice = chooseFxQuote(direct, reverse);
    if (choice.reason === "imprecise") {
      this.logger.warn(
        `Provider quotes for ${from}/${to} are rounded too coarsely to use in either direction`,
      );
    }
    return {
      observation: choice.observation,
      answered: directQuote.answered || (reverseQuote?.answered ?? false),
    };
  }

  /** The `from -> to` quote; `answered` is whether Yahoo returned anything for the symbol. */
  private async fetchRate(
    from: string,
    to: string,
  ): Promise<{ rate: number | null; answered: boolean }> {
    const quote = await this.yahoo.fetchQuote(fxSymbol(from, to));
    if (quote === null) return { rate: null, answered: false };
    return { rate: quote.regularMarketPrice ?? null, answered: true };
  }

  /**
   * The daily closes of one symbol over the window, as observations dated by
   * their bar and kept to [start, end]; a bar without a usable close is
   * dropped. `null` when Yahoo did not answer for the symbol.
   */
  private async fetchWindow(
    from: string,
    to: string,
    start: string,
    end: string,
  ): Promise<FxObservation[] | null> {
    const prices = await this.yahoo.fetchHistoricalWindow(
      fxSymbol(from, to),
      null,
      new Date(`${start}T00:00:00.000Z`),
      new Date(`${end}T23:59:59.999Z`),
    );
    if (prices === null) return null;
    return prices.flatMap((bar) => toObservation(from, to, bar, start, end));
  }
}

function toObservation(
  from: string,
  to: string,
  bar: HistoricalPrice,
  start: string,
  end: string,
): FxObservation[] {
  if (!Number.isFinite(bar.close) || bar.close <= 0) return [];
  const date = bar.date.toISOString().slice(0, 10);
  if (date < start || date > end) return [];
  return [{ from, to, date, rate: bar.close }];
}
