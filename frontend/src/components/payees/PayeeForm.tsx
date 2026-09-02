'use client';

import { useState, useRef, useMemo, useCallback, useEffect, MutableRefObject } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Combobox } from '@/components/ui/Combobox';
import { Select } from '@/components/ui/Select';
import {
  Payee,
  ApplyCategoryToTransactions,
  ContactLookupField,
  ContactLookupReason,
  CONTACT_LOOKUP_FIELDS,
} from '@/types/payee';
import { Category } from '@/types/category';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { payeesApi } from '@/lib/payees';
import { usePreferencesStore } from '@/store/preferencesStore';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';
import { PayeeAliasManager } from './PayeeAliasManager';

/**
 * Exported so the validation rules can be tested directly: `PayeeForm.test.tsx`
 * mocks `zodResolver` away (so its submit handlers see real field values), which
 * makes every rule in here invisible from that suite.
 */
export const buildPayeeSchema = (t: (key: string) => string) => z.object({
  name: z.string().min(1, t('validation.nameRequired')).max(255),
  defaultCategoryId: z.string().optional(),
  notes: z.string().optional(),
  website: z.string().max(2048).optional(),
  address: z.string().max(500).optional(),
  // Refined rather than `.email().or(z.literal(''))`: an emptied field submits
  // "" and that is how a contact detail is cleared, so the blank has to pass --
  // but a union's error message is a generic "invalid input", which would put
  // the wrong text under the field. One predicate keeps both.
  email: z
    .string()
    .max(255)
    .optional()
    .refine((value) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), {
      message: t('validation.emailInvalid'),
    }),
  phone: z.string().max(50).optional(),
});

type PayeeFormData = z.infer<ReturnType<typeof buildPayeeSchema>>;

/** A name shorter than this is not worth a paid lookup on blur. */
const MIN_LOOKUP_NAME_LENGTH = 3;

type LookupState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'done'; reason: ContactLookupReason; detail?: string };

export type PayeeFormSubmitData = PayeeFormData & {
  pendingAliases?: string[];
  applyCategoryToTransactions?: ApplyCategoryToTransactions;
};

interface PayeeFormProps {
  payee?: Payee;
  categories: Category[];
  onSubmit: (data: PayeeFormSubmitData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

export function PayeeForm({ payee, categories, onSubmit, onCancel, onDirtyChange, submitRef }: PayeeFormProps) {
  const t = useTranslations('payees');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(payee?.defaultCategoryId || '');
  const [applyMode, setApplyMode] = useState<ApplyCategoryToTransactions>('none');
  const pendingAliasesRef = useRef<string[]>([]);

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    watch,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<PayeeFormData>({
    resolver: zodResolver(buildPayeeSchema(t)),
    defaultValues: payee
      ? {
          name: payee.name,
          defaultCategoryId: payee.defaultCategoryId || '',
          notes: payee.notes || '',
          website: payee.website || '',
          address: payee.address || '',
          email: payee.email || '',
          phone: payee.phone || '',
        }
      : {
          defaultCategoryId: '',
        },
  });

  useFormDirtyNotify(isDirty, onDirtyChange);

  // ─── contact lookup ───────────────────────────────────────────────────
  //
  // The lookup fills only fields that are still empty, and never persists:
  // the suggestions sit in the form until the user saves. A response belongs
  // to the request that produced it -- a newer name aborts the older request,
  // and an answer whose captured request is no longer the current one is
  // dropped rather than adopted.
  const lookupEnabled = usePreferencesStore(
    (s) => s.preferences?.payeeContactLookupEnabled ?? false,
  );
  const [lookupState, setLookupState] = useState<LookupState>({ status: 'idle' });
  const [suggestedFields, setSuggestedFields] = useState<ReadonlySet<ContactLookupField>>(
    () => new Set(),
  );
  const suggestedRef = useRef<Set<ContactLookupField>>(new Set());
  const applyingRef = useRef(false);
  const lookupRef = useRef<{ name: string; controller: AbortController } | null>(null);
  const lastLookedUpNameRef = useRef('');

  const runLookup = useCallback(
    async (rawName: string, { force = false } = {}) => {
      const name = rawName.trim();
      if (name.length < MIN_LOOKUP_NAME_LENGTH) return;
      if (!force && name === lastLookedUpNameRef.current) return;
      lookupRef.current?.controller.abort();
      const request = { name, controller: new AbortController() };
      lookupRef.current = request;
      lastLookedUpNameRef.current = name;
      setLookupState({ status: 'searching' });

      let result;
      try {
        result = await payeesApi.lookupContact(name, request.controller.signal);
      } catch {
        // An aborted request has already been superseded; anything else is a
        // failure the user must see as one, never as "nothing found".
        if (lookupRef.current !== request) return;
        lookupRef.current = null;
        setLookupState({ status: 'done', reason: 'failed' });
        return;
      }
      if (lookupRef.current !== request) return;
      lookupRef.current = null;

      if (result.reason !== 'ok' || !result.suggestion) {
        setLookupState({ status: 'done', reason: result.reason, detail: result.detail });
        return;
      }
      const filled = new Set<ContactLookupField>();
      applyingRef.current = true;
      try {
        for (const field of CONTACT_LOOKUP_FIELDS) {
          const value = result.suggestion[field];
          if (value && !getValues(field)) {
            setValue(field, value, { shouldDirty: true });
            filled.add(field);
          }
        }
      } finally {
        applyingRef.current = false;
      }
      suggestedRef.current = filled;
      setSuggestedFields(new Set(filled));
      setLookupState({ status: 'done', reason: filled.size > 0 ? 'ok' : 'none' });
    },
    [getValues, setValue],
  );

  // A field the user edits stops being a suggestion, whatever they typed.
  useEffect(() => {
    const subscription = watch((_values, { name }) => {
      if (applyingRef.current || !name) return;
      if (suggestedRef.current.has(name as ContactLookupField)) {
        suggestedRef.current.delete(name as ContactLookupField);
        setSuggestedFields(new Set(suggestedRef.current));
      }
    });
    return () => subscription.unsubscribe();
  }, [watch]);

  useEffect(() => () => lookupRef.current?.controller.abort(), []);

  const clearSuggestions = useCallback(() => {
    applyingRef.current = true;
    try {
      for (const field of suggestedRef.current) {
        setValue(field, '', { shouldDirty: true });
      }
    } finally {
      applyingRef.current = false;
    }
    suggestedRef.current = new Set();
    setSuggestedFields(new Set());
    setLookupState({ status: 'idle' });
  }, [setValue]);

  const nameField = register('name');
  const handleNameBlur = useCallback(
    (event: React.FocusEvent<HTMLInputElement>) => {
      void nameField.onBlur(event);
      // Automatic only for a new payee, and only when the user opted in; an
      // existing payee's values are theirs, so a lookup there is the button.
      if (!payee && lookupEnabled) {
        void runLookup(event.target.value);
      }
    },
    [nameField, payee, lookupEnabled, runLookup],
  );

  const handleFormSubmit = useCallback((data: PayeeFormData) => {
    const submitData: PayeeFormSubmitData = { ...data };
    if (!payee && pendingAliasesRef.current.length > 0) {
      submitData.pendingAliases = pendingAliasesRef.current;
    }
    // Only carry the backfill instruction when editing an existing payee that
    // ends up with a default category and the user opted into applying it.
    if (payee && data.defaultCategoryId && applyMode !== 'none') {
      submitData.applyCategoryToTransactions = applyMode;
    }
    return onSubmit(submitData);
  }, [payee, onSubmit, applyMode]);

  const onFormSubmit = useCallback((e?: React.BaseSyntheticEvent) => {
    handleSubmit(handleFormSubmit)(e);
  }, [handleSubmit, handleFormSubmit]);

  useFormSubmitRef(submitRef, handleSubmit, handleFormSubmit);

  const categoryOptions = useMemo(() => {
    const treeOptions = buildCategoryTree(categories).map(({ category }) => {
      const parentCategory = category.parentId
        ? categories.find(c => c.id === category.parentId)
        : null;
      return {
        value: category.id,
        label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
      };
    });
    return treeOptions;
  }, [categories]);

  const handleCategoryChange = (categoryId: string) => {
    setSelectedCategoryId(categoryId);
    setValue('defaultCategoryId', categoryId || '', { shouldDirty: true });
    // Clearing the category makes the backfill choice meaningless; reset it.
    if (!categoryId) {
      setApplyMode('none');
    }
  };

  // Counts for the backfill option labels. Transfers and split parents are
  // excluded by the backend, so "all" is an upper bound on what changes.
  const uncategorizedCount = payee?.uncategorizedCount ?? 0;
  const transactionCount = payee?.transactionCount ?? 0;
  const showApplyCategory =
    !!payee && !!selectedCategoryId && transactionCount > 0;
  const applyOptions = useMemo(
    () => [
      { value: 'none', label: t('form.applyCategoryNone') },
      {
        value: 'uncategorized',
        label: t('form.applyCategoryUncategorized', { count: uncategorizedCount }),
      },
      { value: 'all', label: t('form.applyCategoryAll', { count: transactionCount }) },
    ],
    [t, uncategorizedCount, transactionCount],
  );

  // Find display name for the initial category
  const defaultCategoryId = payee?.defaultCategoryId;
  const initialCategoryName = useMemo(() => {
    if (!defaultCategoryId) return '';
    const cat = categories.find(c => c.id === defaultCategoryId);
    if (!cat) return '';
    const parent = cat.parentId ? categories.find(c => c.id === cat.parentId) : null;
    return parent ? `${parent.name}: ${cat.name}` : cat.name;
  }, [defaultCategoryId, categories]);

  // noValidate on the form: the email and phone inputs keep their types so a
  // phone offers the right keyboard, but validation is this form's own -- the
  // browser's native bubble is unlocalized and, by blocking the submit event,
  // would stop react-hook-form reporting the real message.
  return (
    <form onSubmit={onFormSubmit} className="space-y-4" noValidate>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            label={t('form.nameLabel')}
            error={errors.name?.message}
            {...nameField}
            onBlur={handleNameBlur}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="md"
          disabled={lookupState.status === 'searching'}
          onClick={() => void runLookup(getValues('name') ?? '', { force: true })}
        >
          {t('form.lookup.button')}
        </Button>
      </div>

      {lookupState.status === 'searching' && (
        <div
          className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400"
          role="status"
          aria-live="polite"
        >
          <LoadingSpinner size="sm" fullContainer={false} />
          <span>{t('form.lookup.searching')}</span>
        </div>
      )}
      {lookupState.status === 'done' && lookupState.reason === 'ok' && suggestedFields.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          <span>{t('form.lookup.suggested')}</span>
          {CONTACT_LOOKUP_FIELDS.filter((field) => suggestedFields.has(field)).map((field) => (
            <Badge key={field} variant="blue">
              {t(`form.${field}Label`)}
            </Badge>
          ))}
          <Button type="button" variant="ghost" size="sm" onClick={clearSuggestions}>
            {t('form.lookup.clear')}
          </Button>
        </div>
      )}
      {lookupState.status === 'done' && lookupState.reason === 'none' && (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('form.lookup.nothingFound')}</p>
      )}
      {lookupState.status === 'done' && lookupState.reason === 'no_provider' && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t.rich('form.lookup.noProvider', {
            link: (chunks) => (
              <Link href="/settings/ai" className="text-blue-600 hover:underline dark:text-blue-400">
                {chunks}
              </Link>
            ),
          })}
        </p>
      )}
      {lookupState.status === 'done' && lookupState.reason === 'failed' && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {lookupState.detail ?? t('form.lookup.failed')}
        </p>
      )}

      <Combobox
        label={t('form.categoryLabel')}
        placeholder={t('selectCategoryPlaceholder')}
        options={categoryOptions}
        value={selectedCategoryId}
        initialDisplayValue={initialCategoryName}
        onChange={handleCategoryChange}
        error={errors.defaultCategoryId?.message}
      />

      {showApplyCategory && (
        <div>
          <Select
            label={t('form.applyCategoryLabel')}
            options={applyOptions}
            value={applyMode}
            onChange={(e) => setApplyMode(e.target.value as ApplyCategoryToTransactions)}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('form.applyCategoryHelp')}
          </p>
        </div>
      )}

      <Input
        label={t('form.notesLabel')}
        error={errors.notes?.message}
        {...register('notes')}
      />

      {/* Rendered as a link on the detail page, so the backend stores only an
          http(s) address and adds https to a bare domain. */}
      <div aria-busy={lookupState.status === 'searching'} className="space-y-4">
      <Input
        label={t('form.websiteLabel')}
        placeholder="starbucks.com"
        error={errors.website?.message}
        {...register('website')}
      />

      {/* Free text, and multi-line because that is how an address is written.
          Nothing geocodes it: the detail page hands the whole string to the
          reader's maps application, which takes a single query anyway. */}
      <div>
        <label
          htmlFor="payee-address"
          className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          {t('form.addressLabel')}
        </label>
        <textarea
          id="payee-address"
          rows={3}
          className="block w-full rounded-md border-gray-300 shadow-sm focus:outline-none focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:focus-visible:border-blue-400 dark:focus-visible:ring-blue-400"
          {...register('address')}
        />
        {errors.address && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">
            {errors.address.message}
          </p>
        )}
      </div>

      <Input
        label={t('form.emailLabel')}
        type="email"
        error={errors.email?.message}
        {...register('email')}
      />

      <Input
        label={t('form.phoneLabel')}
        type="tel"
        error={errors.phone?.message}
        {...register('phone')}
      />
      </div>

      {payee ? (
        <PayeeAliasManager payeeId={payee.id} />
      ) : (
        <PayeeAliasManager onPendingAliasesChange={(aliases) => { pendingAliasesRef.current = aliases; }} />
      )}

      <FormActions onCancel={onCancel} submitLabel={payee ? t('form.submitUpdate') : t('form.submitCreate')} isSubmitting={isSubmitting} />
    </form>
  );
}
