import apiClient from './api';
import {
  MonthlyNetWorth,
  MonthlyInvestmentValue,
  DailyInvestmentValue,
  InvestmentBreakdown,
  InvestmentBreakdownGranularity,
  PortfolioPeriodResult,
  PortfolioPeriodResults,
} from '@/types/net-worth';

export const netWorthApi = {
  getMonthly: async (params?: {
    startDate?: string;
    endDate?: string;
  }): Promise<MonthlyNetWorth[]> => {
    const response = await apiClient.get<MonthlyNetWorth[]>(
      '/net-worth/monthly',
      { params },
    );
    return response.data;
  },

  getInvestmentsMonthly: async (params?: {
    startDate?: string;
    endDate?: string;
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<MonthlyInvestmentValue[]> => {
    const response = await apiClient.get<MonthlyInvestmentValue[]>(
      '/net-worth/investments-monthly',
      { params },
    );
    return response.data;
  },

  getInvestmentsDaily: async (params?: {
    startDate?: string;
    endDate?: string;
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<DailyInvestmentValue[]> => {
    const response = await apiClient.get<DailyInvestmentValue[]>(
      '/net-worth/investments-daily',
      { params },
    );
    return response.data;
  },

  /**
   * The first day on or after `onOrAfter` on which anything held was actually
   * priced — a trading day for this portfolio, which the daily series cannot
   * report because it values every calendar day from the last close at or
   * before it. `date` is null when the scope holds nothing priced; the caller
   * keeps its calendar boundary rather than inventing a trading day.
   */
  getFirstPricedDay: async (params: {
    onOrAfter: string;
    accountIds?: string;
  }): Promise<{ date: string | null }> => {
    const response = await apiClient.get<{ date: string | null }>(
      '/net-worth/investments-first-priced-day',
      { params },
    );
    return response.data;
  },

  /**
   * What the portfolio did over the window, net of the money its owner moved
   * in or out: `valueChange`, `netExternalFlows` and `investmentResult` as
   * three separate figures, with a percentage only over the last of them.
   *
   * `period` names the window and the SERVER resolves it, from the same
   * arithmetic the batch route uses -- so a chart's card and the performance
   * card beside it report one figure under one caption. It is what every
   * portfolio chart sends: the window a price chart DRAWS is deliberately not
   * the period it names (`portfolio-range-window.ts`), and sending the drawn
   * one measured 1D over a week and All over nothing at all.
   *
   * `startDate`/`baselineDate` name an explicit window instead, for a caller
   * with no preset to name. `baselineDate` is the close the period is measured
   * from where that is earlier than `startDate`.
   */
  getInvestmentsPeriodResult: async (params: {
    period?: string;
    startDate?: string;
    endDate?: string;
    baselineDate?: string;
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<PortfolioPeriodResult> => {
    const response = await apiClient.get<PortfolioPeriodResult>(
      '/net-worth/investments-period-result',
      { params },
    );
    return response.data;
  },

  /**
   * The same three figures as `getInvestmentsPeriodResult`, for several
   * trailing windows at once.
   *
   * The windows are the server's own arithmetic: it decides what today is and
   * where each preset opens, so six surfaces cannot disagree about where a
   * month begins, and one valuation answers all of them.
   */
  getInvestmentsPeriodResults: async (params?: {
    periods?: string;
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<PortfolioPeriodResults> => {
    const response = await apiClient.get<PortfolioPeriodResults>(
      '/net-worth/investments-period-results',
      { params },
    );
    return response.data;
  },

  getInvestmentsBreakdown: async (params: {
    granularity: InvestmentBreakdownGranularity;
    startDate?: string;
    endDate?: string;
    accountIds?: string;
    displayCurrency?: string;
  }): Promise<InvestmentBreakdown> => {
    const response = await apiClient.get<InvestmentBreakdown>(
      '/net-worth/investments-breakdown',
      { params },
    );
    return response.data;
  },

  recalculate: async (): Promise<{ success: boolean }> => {
    const response = await apiClient.post<{ success: boolean }>(
      '/net-worth/recalculate',
    );
    return response.data;
  },
};
