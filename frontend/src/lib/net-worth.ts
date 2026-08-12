import apiClient from './api';
import {
  MonthlyNetWorth,
  MonthlyInvestmentValue,
  DailyInvestmentValue,
  InvestmentBreakdown,
  InvestmentBreakdownGranularity,
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
