'use client';

import { MutableRefObject } from 'react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { FormActions } from '@/components/ui/FormActions';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import {
  SECURITY_DOCUMENT_TYPES,
  type CreateSecurityDocumentData,
  type SecurityDocument,
  type SecurityDocumentType,
} from '@/types/investment';

/**
 * Schemes the Open action is willing to turn into a link.
 *
 * Client-side twin of the backend's `@IsUrl({ protocols: [...] })`. The server
 * is the authority -- this is here so a mistyped address is caught before a round
 * trip, not as the security control.
 */
const ALLOWED_SCHEME = /^https?:\/\//i;

const buildSchema = (t: (key: string) => string) =>
  z.object({
    documentType: z.enum(SECURITY_DOCUMENT_TYPES),
    name: z.string().trim().min(1, t('documents.validation.nameRequired')).max(255),
    documentDate: z.string().optional(),
    url: z
      .string()
      .trim()
      .min(1, t('documents.validation.urlRequired'))
      .max(2048)
      .refine((value) => ALLOWED_SCHEME.test(value), t('documents.validation.urlScheme')),
    notes: z.string().max(2000).optional(),
  });

type DocumentFormData = z.infer<ReturnType<typeof buildSchema>>;

interface SecurityDocumentFormProps {
  document?: SecurityDocument;
  onSubmit: (data: CreateSecurityDocumentData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

/** Create or edit one document link. */
export function SecurityDocumentForm({
  document,
  onSubmit,
  onCancel,
  onDirtyChange,
  submitRef,
}: SecurityDocumentFormProps) {
  const t = useTranslations('securityDetail');
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<DocumentFormData>({
    resolver: zodResolver(buildSchema(t)),
    defaultValues: {
      documentType: document?.documentType ?? 'OTHER',
      name: document?.name ?? '',
      documentDate: document?.documentDate ?? '',
      url: document?.url ?? '',
      notes: document?.notes ?? '',
    },
  });

  useFormSubmitRef(submitRef, handleSubmit, onFormSubmit);
  useFormDirtyNotify(isDirty, onDirtyChange);

  async function onFormSubmit(data: DocumentFormData) {
    const payload: CreateSecurityDocumentData = {
      documentType: data.documentType,
      name: data.name.trim(),
      url: data.url.trim(),
      // Omitted rather than sent empty: the column is nullable and an empty
      // string is not a date.
      ...(data.documentDate ? { documentDate: data.documentDate } : {}),
      ...(data.notes?.trim() ? { notes: data.notes.trim() } : {}),
    };
    try {
      await onSubmit(payload);
    } catch {
      // The caller has already surfaced its own error and keeps the form open;
      // rethrowing would leave react-hook-form with an unhandled rejection.
    }
  }

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
      <div>
        <label
          htmlFor="documentType"
          className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          {t('documents.columns.type')}
        </label>
        <select
          id="documentType"
          {...register('documentType')}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        >
          {SECURITY_DOCUMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`documents.types.${type}` as Parameters<typeof t>[0])}
            </option>
          ))}
        </select>
      </div>

      <Input
        id="name"
        label={t('documents.columns.name')}
        error={errors.name?.message}
        {...register('name')}
      />

      {/* `DateInput`, never a raw date input: it carries the locale-aware
          parsing and the app's own calendar popover. */}
      <div>
        <DateInput
          id="documentDate"
          label={t('documents.form.date')}
          error={errors.documentDate?.message}
          {...register('documentDate')}
          onDateChange={(date) =>
            setValue('documentDate', date, { shouldDirty: true })
          }
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('documents.form.dateHint')}
        </p>
      </div>

      <Input
        id="url"
        label={t('documents.form.url')}
        placeholder="https://"
        error={errors.url?.message}
        {...register('url')}
      />

      <div>
        <label
          htmlFor="notes"
          className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          {t('documents.form.notes')}
        </label>
        <textarea
          id="notes"
          rows={2}
          {...register('notes')}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
      </div>

      <FormActions
        onCancel={onCancel}
        isSubmitting={isSubmitting}
        submitLabel={
          document ? t('documents.form.save') : t('documents.form.create')
        }
      />
    </form>
  );
}

export type { SecurityDocumentType };
