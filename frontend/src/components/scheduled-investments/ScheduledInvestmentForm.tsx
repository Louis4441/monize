'use client';

import { useEffect, useMemo, useState, MutableRefObject } from 'react';
import { useForm, Resolver } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { Select } from '@/components/ui/Select';
import { investmentsApi } from '@/lib/investments';
import { scheduledInvestmentsApi } from '@/lib/scheduled-investments';
import { getLocalDateString } from '@/lib/utils';
import { Account } from '@/types/account';
import { InvestmentAction, Security } from '@/types/investment';
import {
  FrequencyType,
  FREQUENCY_LABELS,
} from '@/types/scheduled-transaction';
import {
  ScheduledInvestmentTransaction,
  CreateScheduledInvestmentData,
} from '@/types/scheduled-investment';
import { getCurrencySymbol } from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';

const ALL_ACTIONS: InvestmentAction[] = [
  'BUY',
  'SELL',
  'DIVIDEND',
  'INTEREST',
  'CAPITAL_GAIN',
  'REINVEST',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'ADD_SHARES',
  'REMOVE_SHARES',
];

const ACTION_LABELS: Record<InvestmentAction, string> = {
  BUY: 'Buy',
  SELL: 'Sell',
  DIVIDEND: 'Dividend',
  INTEREST: 'Interest',
  CAPITAL_GAIN: 'Capital Gain',
  SPLIT: 'Stock Split',
  TRANSFER_IN: 'Transfer In',
  TRANSFER_OUT: 'Transfer Out',
  REINVEST: 'Reinvest (DRIP)',
  ADD_SHARES: 'Add Shares',
  REMOVE_SHARES: 'Remove Shares',
};

const SECURITY_REQUIRED: InvestmentAction[] = [
  'BUY', 'SELL', 'DIVIDEND', 'CAPITAL_GAIN', 'REINVEST', 'ADD_SHARES', 'REMOVE_SHARES',
];
const QUANTITY_PRICE_ACTIONS: InvestmentAction[] = ['BUY', 'SELL', 'REINVEST'];
const QUANTITY_ONLY_ACTIONS: InvestmentAction[] = ['ADD_SHARES', 'REMOVE_SHARES'];
const TOTAL_AMOUNT_ACTIONS: InvestmentAction[] = [
  'DIVIDEND', 'INTEREST', 'CAPITAL_GAIN', 'TRANSFER_IN', 'TRANSFER_OUT',
];
const FUNDING_ACCOUNT_ACTIONS: InvestmentAction[] = ['BUY', 'SELL'];

const schema = z.object({
  accountId: z.string().min(1, 'Account is required'),
  action: z.enum(ALL_ACTIONS as [InvestmentAction, ...InvestmentAction[]]),
  name: z.string().min(1, 'Name is required').max(255),
  securityId: z.string().optional(),
  fundingAccountId: z.string().optional(),
  quantity: z.coerce.number().min(0).optional(),
  price: z.coerce.number().min(0).optional(),
  commission: z.coerce.number().min(0).optional(),
  totalAmount: z.coerce.number().optional(),
  exchangeRate: z.coerce.number().gt(0).optional(),
  description: z.string().max(500).optional(),
  frequency: z.enum([
    'ONCE', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'EVERY4WEEKS',
    'SEMIMONTHLY', 'MONTHLY', 'QUARTERLY', 'YEARLY',
  ]),
  nextDueDate: z.string().min(1, 'Next due date is required'),
  endDate: z.string().optional(),
  occurrencesRemaining: z.coerce.number().int().min(0).optional(),
  autoPost: z.boolean().default(false),
  reminderDaysBefore: z.coerce.number().int().min(0).default(3),
});

type FormData = z.infer<typeof schema>;

interface Props {
  accounts: Account[];
  scheduled?: ScheduledInvestmentTransaction;
  defaultAccountId?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

export function ScheduledInvestmentForm({
  accounts,
  scheduled,
  defaultAccountId,
  onSuccess,
  onCancel,
  onDirtyChange,
  submitRef,
}: Props) {
  const { defaultCurrency } = useNumberFormat();
  const [securities, setSecurities] = useState<Security[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const brokerageAccounts = useMemo(
    () =>
      accounts
        .filter((a) => a.accountSubType === 'INVESTMENT_BROKERAGE')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [accounts],
  );

  const fundingAccounts = useMemo(
    () =>
      accounts
        .filter(
          (a) =>
            a.accountSubType !== 'INVESTMENT_CASH' &&
            a.accountType !== 'CASH' &&
            a.accountType !== 'ASSET' &&
            a.accountSubType !== 'INVESTMENT_BROKERAGE',
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [accounts],
  );

  useEffect(() => {
    investmentsApi
      .getSecurities()
      .then(setSecurities)
      .catch(() => setSecurities([]));
  }, []);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isDirty },
  } = useForm<FormData>({
    resolver: zodResolver(schema) as Resolver<FormData>,
    defaultValues: scheduled
      ? {
          accountId: scheduled.accountId,
          action: scheduled.action,
          name: scheduled.name,
          securityId: scheduled.securityId || '',
          fundingAccountId: scheduled.fundingAccountId || '',
          quantity: scheduled.quantity ?? undefined,
          price: scheduled.price ?? undefined,
          commission: scheduled.commission ?? 0,
          totalAmount: scheduled.totalAmount ?? undefined,
          exchangeRate: scheduled.exchangeRate ?? undefined,
          description: scheduled.description || '',
          frequency: scheduled.frequency,
          nextDueDate: scheduled.nextDueDate.split('T')[0],
          endDate: scheduled.endDate?.split('T')[0] || '',
          occurrencesRemaining: scheduled.occurrencesRemaining ?? undefined,
          autoPost: scheduled.autoPost,
          reminderDaysBefore: scheduled.reminderDaysBefore,
        }
      : {
          accountId: defaultAccountId || '',
          action: 'BUY',
          name: '',
          securityId: '',
          fundingAccountId: '',
          quantity: undefined,
          price: undefined,
          commission: 0,
          totalAmount: undefined,
          exchangeRate: undefined,
          description: '',
          frequency: 'MONTHLY' as FrequencyType,
          nextDueDate: getLocalDateString(),
          endDate: '',
          occurrencesRemaining: undefined,
          autoPost: false,
          reminderDaysBefore: 3,
        },
  });

  useFormDirtyNotify(isDirty, onDirtyChange);

  const watchedAction = watch('action') as InvestmentAction;
  const watchedAccountId = watch('accountId');
  const watchedSecurityId = watch('securityId');

  const accountCurrency = useMemo(() => {
    const acc = accounts.find((a) => a.id === watchedAccountId);
    return acc?.currencyCode ?? defaultCurrency;
  }, [accounts, watchedAccountId, defaultCurrency]);

  const transactionCurrency = useMemo(() => {
    if (watchedSecurityId) {
      const sec = securities.find((s) => s.id === watchedSecurityId);
      if (sec) return sec.currencyCode;
    }
    return accountCurrency;
  }, [watchedSecurityId, securities, accountCurrency]);

  const currencySymbol = getCurrencySymbol(transactionCurrency || 'USD');

  const showSecurity = SECURITY_REQUIRED.includes(watchedAction);
  const showQuantityPrice = QUANTITY_PRICE_ACTIONS.includes(watchedAction);
  const showQuantityOnly = QUANTITY_ONLY_ACTIONS.includes(watchedAction);
  const showTotalAmount = TOTAL_AMOUNT_ACTIONS.includes(watchedAction);
  const showFundingAccount = FUNDING_ACCOUNT_ACTIONS.includes(watchedAction);

  const onSubmit = async (raw: FormData) => {
    setIsLoading(true);
    try {
      if (showSecurity && !raw.securityId) {
        toast.error('Security is required for this action');
        return;
      }
      if (showQuantityPrice && (!raw.quantity || raw.quantity <= 0)) {
        toast.error('Quantity must be positive');
        return;
      }
      if (showQuantityPrice && (raw.price === undefined || raw.price < 0)) {
        toast.error('Price is required');
        return;
      }
      if (showQuantityOnly && (!raw.quantity || raw.quantity <= 0)) {
        toast.error('Quantity must be positive');
        return;
      }
      if (showTotalAmount && (raw.totalAmount === undefined)) {
        toast.error('Total amount is required for this action');
        return;
      }

      const payload: CreateScheduledInvestmentData = {
        accountId: raw.accountId,
        action: raw.action,
        name: raw.name,
        securityId: raw.securityId || undefined,
        fundingAccountId: raw.fundingAccountId || undefined,
        quantity: showQuantityPrice || showQuantityOnly ? raw.quantity : undefined,
        price: showQuantityPrice ? raw.price : undefined,
        commission: raw.commission || 0,
        totalAmount: showTotalAmount ? raw.totalAmount : undefined,
        currencyCode: transactionCurrency,
        exchangeRate: raw.exchangeRate || undefined,
        description: raw.description || undefined,
        frequency: raw.frequency,
        nextDueDate: raw.nextDueDate,
        endDate: raw.endDate || undefined,
        occurrencesRemaining: raw.occurrencesRemaining,
        autoPost: raw.autoPost,
        reminderDaysBefore: raw.reminderDaysBefore,
      };

      if (scheduled) {
        await scheduledInvestmentsApi.update(scheduled.id, payload);
        toast.success('Scheduled investment updated');
      } else {
        await scheduledInvestmentsApi.create(payload);
        toast.success('Scheduled investment created');
      }
      onSuccess?.();
    } catch (err) {
      toast.error(getErrorMessage(err, 'An error occurred'));
    } finally {
      setIsLoading(false);
    }
  };

  useFormSubmitRef(submitRef, handleSubmit, onSubmit);

  const securityOptions = useMemo(
    () =>
      securities
        .slice()
        .sort((a, b) => a.symbol.localeCompare(b.symbol))
        .map((s) => ({
          value: s.id,
          label: `${s.symbol} - ${s.name}`,
        })),
    [securities],
  );

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Input
        label="Name"
        placeholder="e.g. Monthly VOO DCA"
        {...register('name')}
        error={errors.name?.message}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select
          label="Brokerage Account"
          {...register('accountId')}
          error={errors.accountId?.message}
          options={[
            { value: '', label: 'Select account' },
            ...brokerageAccounts.map((a) => ({ value: a.id, label: a.name })),
          ]}
        />

        <Select
          label="Action"
          {...register('action')}
          options={ALL_ACTIONS.map((a) => ({
            value: a,
            label: ACTION_LABELS[a],
          }))}
        />
      </div>

      {showSecurity && (
        <Select
          label="Security"
          {...register('securityId')}
          error={errors.securityId?.message}
          options={[
            { value: '', label: 'Select security' },
            ...securityOptions,
          ]}
        />
      )}

      {showFundingAccount && (
        <Select
          label="Funding account (optional - defaults to brokerage cash)"
          {...register('fundingAccountId')}
          options={[
            { value: '', label: '(use brokerage cash)' },
            ...fundingAccounts.map((a) => ({ value: a.id, label: a.name })),
          ]}
        />
      )}

      {(showQuantityPrice || showQuantityOnly) && (
        <Input
          label="Quantity (shares)"
          type="number"
          step="0.00000001"
          min={0}
          {...register('quantity')}
          error={errors.quantity?.message}
        />
      )}

      {showQuantityPrice && (
        <Input
          label={`Price per share (${currencySymbol})`}
          type="number"
          step="0.000001"
          min={0}
          {...register('price')}
          error={errors.price?.message}
        />
      )}

      {showQuantityPrice && (
        <Input
          label={`Commission (${currencySymbol})`}
          type="number"
          step="0.0001"
          min={0}
          {...register('commission')}
          error={errors.commission?.message}
        />
      )}

      {showTotalAmount && (
        <Input
          label={`Total amount (${currencySymbol})`}
          type="number"
          step="0.0001"
          {...register('totalAmount')}
          error={errors.totalAmount?.message}
        />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select
          label="Frequency"
          {...register('frequency')}
          options={Object.entries(FREQUENCY_LABELS).map(([v, l]) => ({
            value: v,
            label: l,
          }))}
        />
        <DateInput
          label="Next due date"
          {...register('nextDueDate')}
          error={errors.nextDueDate?.message}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <DateInput
          label="End date (optional)"
          {...register('endDate')}
        />
        <Input
          label="Occurrences remaining (optional)"
          type="number"
          min={0}
          {...register('occurrencesRemaining')}
        />
      </div>

      <div className="flex items-center gap-3">
        <input
          id="autoPost-sit"
          type="checkbox"
          className="h-4 w-4"
          {...register('autoPost')}
        />
        <label htmlFor="autoPost-sit" className="text-sm">
          Auto-post each occurrence on its due date
        </label>
      </div>

      <Input
        label="Description (optional)"
        {...register('description')}
        error={errors.description?.message}
      />

      <FormActions
        onCancel={onCancel}
        isSubmitting={isLoading}
        submitLabel={scheduled ? 'Update' : 'Create'}
      />
    </form>
  );
}
