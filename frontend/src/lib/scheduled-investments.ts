import apiClient from './api';
import {
  ScheduledInvestmentTransaction,
  CreateScheduledInvestmentData,
  UpdateScheduledInvestmentData,
  PostScheduledInvestmentData,
} from '@/types/scheduled-investment';
import { dedupe, invalidateCache } from './apiCache';

const BASE = '/scheduled-investment-transactions';

export const scheduledInvestmentsApi = {
  create: async (
    data: CreateScheduledInvestmentData,
  ): Promise<ScheduledInvestmentTransaction> => {
    const res = await apiClient.post<ScheduledInvestmentTransaction>(BASE, data);
    invalidateCache('scheduled-inv:');
    return res.data;
  },

  getAll: async (): Promise<ScheduledInvestmentTransaction[]> =>
    dedupe(
      'scheduled-inv:all',
      async () => {
        const res = await apiClient.get<ScheduledInvestmentTransaction[]>(BASE);
        return res.data;
      },
      120_000,
    ),

  getUpcoming: async (
    days?: number,
  ): Promise<ScheduledInvestmentTransaction[]> => {
    const res = await apiClient.get<ScheduledInvestmentTransaction[]>(
      `${BASE}/upcoming`,
      { params: days ? { days } : undefined },
    );
    return res.data;
  },

  getById: async (id: string): Promise<ScheduledInvestmentTransaction> => {
    const res = await apiClient.get<ScheduledInvestmentTransaction>(
      `${BASE}/${id}`,
    );
    return res.data;
  },

  update: async (
    id: string,
    data: UpdateScheduledInvestmentData,
  ): Promise<ScheduledInvestmentTransaction> => {
    const res = await apiClient.patch<ScheduledInvestmentTransaction>(
      `${BASE}/${id}`,
      data,
    );
    invalidateCache('scheduled-inv:');
    return res.data;
  },

  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`${BASE}/${id}`);
    invalidateCache('scheduled-inv:');
  },

  post: async (
    id: string,
    data?: PostScheduledInvestmentData,
  ): Promise<ScheduledInvestmentTransaction | null> => {
    const res = await apiClient.post<ScheduledInvestmentTransaction | null>(
      `${BASE}/${id}/post`,
      data || {},
    );
    invalidateCache('scheduled-inv:');
    return res.data;
  },

  skip: async (id: string): Promise<ScheduledInvestmentTransaction> => {
    const res = await apiClient.post<ScheduledInvestmentTransaction>(
      `${BASE}/${id}/skip`,
      {},
    );
    invalidateCache('scheduled-inv:');
    return res.data;
  },
};
