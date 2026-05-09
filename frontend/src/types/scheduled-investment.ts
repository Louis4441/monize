import { Account } from './account';
import { InvestmentAction, Security } from './investment';
import { FrequencyType } from './scheduled-transaction';

export interface ScheduledInvestmentTransaction {
  id: string;
  userId: string;
  accountId: string;
  account: Account | null;
  fundingAccountId: string | null;
  fundingAccount: Account | null;
  securityId: string | null;
  security: Security | null;
  action: InvestmentAction;
  name: string;
  quantity: number | null;
  price: number | null;
  commission: number;
  totalAmount: number | null;
  currencyCode: string | null;
  exchangeRate: number | null;
  description: string | null;
  frequency: FrequencyType;
  nextDueDate: string;
  startDate: string | null;
  endDate: string | null;
  occurrencesRemaining: number | null;
  totalOccurrences: number | null;
  isActive: boolean;
  autoPost: boolean;
  reminderDaysBefore: number;
  lastPostedDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledInvestmentData {
  accountId: string;
  fundingAccountId?: string;
  securityId?: string;
  action: InvestmentAction;
  name: string;
  quantity?: number;
  price?: number;
  commission?: number;
  totalAmount?: number;
  currencyCode?: string;
  exchangeRate?: number;
  description?: string;
  frequency: FrequencyType;
  nextDueDate: string;
  startDate?: string;
  endDate?: string;
  occurrencesRemaining?: number;
  isActive?: boolean;
  autoPost?: boolean;
  reminderDaysBefore?: number;
}

export type UpdateScheduledInvestmentData = Partial<CreateScheduledInvestmentData>;

export interface PostScheduledInvestmentData {
  transactionDate?: string;
  quantity?: number;
  price?: number;
  totalAmount?: number;
}
