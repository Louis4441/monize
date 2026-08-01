import apiClient from './api';
import {
  GemRange,
  GemStrategyConfigInput,
  GemStrategyReport,
} from '@/types/gem-strategy';

/**
 * Read/act client for the GEM strategy report. The report is one server-side
 * read model (see `types/gem-strategy.ts`); the UI never derives the signal
 * itself, it only picks the chart range and marks an operation as executed.
 */
export const gemStrategyApi = {
  /**
   * Load the whole report. `range` only affects the performance series;
   * `strategyId` picks a scenario, defaulting to the user's first.
   */
  getReport: async (
    range: GemRange = '1Y',
    strategyId?: string,
  ): Promise<GemStrategyReport> => {
    const response = await apiClient.get<GemStrategyReport>(
      '/strategies/gem/report',
      { params: { range, strategyId } },
    );
    return response.data;
  },

  /** Start a new scenario and return its (empty) report. */
  createStrategy: async (
    name: string,
    range: GemRange = '1Y',
  ): Promise<GemStrategyReport> => {
    const response = await apiClient.post<GemStrategyReport>(
      '/strategies/gem',
      { name },
      { params: { range } },
    );
    return response.data;
  },

  /**
   * Delete a scenario with its assignments and evaluation history. Returns the
   * report for whatever scenario is left.
   */
  deleteStrategy: async (
    strategyId: string,
    range: GemRange = '1Y',
  ): Promise<GemStrategyReport> => {
    const response = await apiClient.delete<GemStrategyReport>(
      `/strategies/gem/${strategyId}`,
      { params: { range } },
    );
    return response.data;
  },

  /**
   * Create or update the strategy configuration (accounts, cadence, costs, and
   * the instrument bound to each role). Returns the refreshed report so the page
   * reflects the new configuration -- including a freshly evaluated signal -- in
   * one round trip.
   *
   * Assigning an instrument that has no price history yet makes the server
   * fetch it from the quote provider before evaluating, so this call gets the
   * same generous timeout as the other backfilling endpoints rather than the
   * client's 10s default.
   */
  updateConfig: async (
    config: GemStrategyConfigInput,
    range: GemRange = '1Y',
    strategyId?: string,
  ): Promise<GemStrategyReport> => {
    const response = await apiClient.put<GemStrategyReport>(
      '/strategies/gem',
      config,
      { params: { range, strategyId }, timeout: 120_000 },
    );
    return response.data;
  },

  /**
   * Record that the user carried out the operation the given signal asked for.
   * Returns the refreshed report so the page reflects the new state in one
   * round trip.
   */
  markExecuted: async (
    signalId: string,
    range: GemRange = '1Y',
  ): Promise<GemStrategyReport> => {
    const response = await apiClient.post<GemStrategyReport>(
      `/strategies/gem/signals/${signalId}/executed`,
      {},
      { params: { range } },
    );
    return response.data;
  },
};
