'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { RuleCardShell } from '@/components/rules/RuleCardShell';
import type { RuleOptions } from '@/components/rules/use-rule-options';
import { Combobox } from '@/components/ui/Combobox';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import { changeActionType, type EditorAction } from '@/lib/rule-actions';
import { MAX_RULE_AI_INSTRUCTION_LENGTH, isRuleActionType } from '@/lib/rule-fields';
import { cn, inputBaseClasses } from '@/lib/utils';
import type { RuleActionType } from '@/types/transaction-rule';

interface RuleActionCardProps {
  action: EditorAction;
  /** The types this card may be set to (`availableActionTypes`). */
  types: readonly RuleActionType[];
  options: RuleOptions;
  actions: RowAction[];
  errors: readonly string[];
  onChange: (action: EditorAction) => void;
}

/** The "Only if empty" switch of `set_category` and `set_payee`, with its explanation. */
function OnlyIfEmpty({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  const t = useTranslations('rules.editor.action');
  return (
    <div className="flex items-center gap-2 pt-1">
      <ToggleSwitch checked={checked} onChange={onChange} label={t('onlyIfEmpty')} />
      <span className="text-sm text-gray-700 dark:text-gray-300">{t('onlyIfEmpty')}</span>
      <InfoTooltip text={t('onlyIfEmptyHelp')} placement="top" usePortal />
    </div>
  );
}

function ActionParameters({ action, options, onChange }: Pick<RuleActionCardProps, 'action' | 'options' | 'onChange'>) {
  const t = useTranslations('rules.editor');

  switch (action.type) {
    case 'add_tags':
    case 'remove_tags':
      return (
        <MultiSelect
          label={t('action.tags')}
          options={options.tags}
          value={[...action.tagIds]}
          onChange={(tagIds) => onChange({ ...action, tagIds })}
          placeholder={t('value.tags')}
        />
      );
    case 'set_category':
      return (
        <div>
          <Combobox
            label={t('action.category')}
            placeholder={t('value.category')}
            options={options.categories}
            value={action.categoryId}
            onChange={(categoryId) => onChange({ ...action, categoryId })}
            valueIsId
            usePortal
          />
          <OnlyIfEmpty checked={action.onlyIfEmpty} onChange={(onlyIfEmpty) => onChange({ ...action, onlyIfEmpty })} />
        </div>
      );
    case 'set_payee':
      return (
        <div>
          <Combobox
            label={t('action.payee')}
            placeholder={t('value.payee')}
            options={options.payees}
            value={action.payeeId}
            onChange={(payeeId) => onChange({ ...action, payeeId })}
            valueIsId
            usePortal
          />
          <OnlyIfEmpty checked={action.onlyIfEmpty} onChange={(onlyIfEmpty) => onChange({ ...action, onlyIfEmpty })} />
        </div>
      );
    case 'request_ai_review':
      return (
        <div>
          <label htmlFor={`${action.uid}-instruction`} className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('action.instruction')}
          </label>
          <textarea
            id={`${action.uid}-instruction`}
            rows={2}
            maxLength={MAX_RULE_AI_INSTRUCTION_LENGTH}
            value={action.instruction}
            placeholder={t('action.instructionPlaceholder')}
            onChange={(e) => onChange({ ...action, instruction: e.target.value })}
            className={cn(inputBaseClasses, 'border px-3 py-2 font-sans focus-visible:ring-1 focus-visible:outline-none')}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('action.instructionHelp')}</p>
          <Link href="/ai-reviews" className="mt-1 inline-block text-xs text-blue-600 hover:underline dark:text-blue-400">
            {t('action.reviewInbox')}
          </Link>
        </div>
      );
  }
}

/**
 * One action: its type, and the parameters that type takes. Changing the type
 * starts the parameters over (the card keeps its place). The type list leaves
 * out `request_ai_review` when another card already holds it, because the
 * server allows one per rule.
 */
export function RuleActionCard({ action, types, options, actions, errors, onChange }: RuleActionCardProps) {
  const t = useTranslations('rules.editor');

  return (
    <RuleCardShell label={t('action.title')} actions={actions} errors={errors}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Select
          id={`${action.uid}-type`}
          label={t('action.type')}
          value={action.type}
          options={types.map((type) => ({ value: type, label: t(`actionTypes.${type}`) }))}
          onChange={(e) => {
            if (isRuleActionType(e.target.value)) onChange(changeActionType(action, e.target.value));
          }}
        />
        <ActionParameters action={action} options={options} onChange={onChange} />
      </div>
    </RuleCardShell>
  );
}
