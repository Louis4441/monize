import { LumpSum } from '@/lib/loan-schedule';

/** A saved overpayment simulation for a loan/mortgage account */
export interface LoanScenario {
  id: string;
  userId: string;
  accountId: string;
  name: string;
  recurringExtraAmount: number | null;
  recurringExtraStartDate: string | null;
  recurringExtraEndDate: string | null;
  lumpSums: LumpSum[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateLoanScenarioData {
  name: string;
  recurringExtraAmount?: number | null;
  recurringExtraStartDate?: string | null;
  recurringExtraEndDate?: string | null;
  lumpSums?: LumpSum[];
}

export type UpdateLoanScenarioData = Partial<CreateLoanScenarioData>;
