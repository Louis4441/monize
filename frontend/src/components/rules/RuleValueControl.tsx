'use client';

import { useTranslations } from 'next-intl';
import { Combobox } from '@/components/ui/Combobox';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Input } from '@/components/ui/Input';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { RuleOption, RuleOptions } from '@/components/rules/use-rule-options';
import {
  MAX_RULE_TEXT_LENGTH,
  RULE_CONDITION_FIELDS,
  RULE_OPERATOR_SHAPES,
  isEditorRuleField,
} from '@/lib/rule-fields';
import type { EditorLeaf, EditorValue } from '@/lib/rule-tree';

interface RuleValueControlProps {
  leaf: EditorLeaf;
  options: RuleOptions;
  onChange: (value: EditorValue) => void;
}

const asString = (v: EditorValue): string => (typeof v === 'string' ? v : '');
const asNumber = (v: EditorValue): number | undefined => (typeof v === 'number' ? v : undefined);
const asStrings = (v: EditorValue): string[] =>
  Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : [];
const asRange = (v: EditorValue): [number | undefined, number | undefined] => {
  const list = Array.isArray(v) ? (v as (number | undefined)[]) : [];
  return [list[0], list[1]];
};

/** Codes already chosen stay selectable even when the user has since deactivated them. */
function withSelected(codes: readonly string[], selected: readonly string[]): string[] {
  return [...new Set([...codes, ...selected.filter((c) => c !== '')])].sort();
}

/**
 * The value control for one leaf: the picker the transaction form uses for
 * that kind of field, so a rule never shows an id. Which control it is follows
 * from the field's kind and the operator's shape (none, one, a list, a range).
 */
export function RuleValueControl({ leaf, options, onChange }: RuleValueControlProps) {
  const t = useTranslations('rules.editor');
  const spec = RULE_CONDITION_FIELDS[leaf.field];
  const shape = RULE_OPERATOR_SHAPES[leaf.op];
  const id = `${leaf.uid}-value`;
  const label = t('condition.value');
  const value = leaf.value;

  if (shape === 'none') return null;

  // A field without a control yet (task X5): show the stored value as it is, never a wrong control.
  if (!isEditorRuleField(leaf.field)) {
    return (
      <div>
        <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>
        <code className="block py-2 text-sm text-gray-700 dark:text-gray-300">{JSON.stringify(value ?? null)}</code>
      </div>
    );
  }

  switch (spec.kind) {
    case 'accountId':
    case 'payeeId':
    case 'categoryId': {
      const list =
        spec.kind === 'accountId' ? options.accounts : spec.kind === 'payeeId' ? options.payees : options.categories;
      if (shape === 'list') {
        const placeholder =
          spec.kind === 'accountId'
            ? t('value.accounts')
            : spec.kind === 'payeeId'
              ? t('value.payees')
              : t('value.categories');
        return (
          <MultiSelect label={label} options={list} value={asStrings(value)} onChange={onChange} placeholder={placeholder} />
        );
      }
      const placeholder =
        spec.kind === 'accountId' ? t('value.account') : spec.kind === 'payeeId' ? t('value.payee') : t('value.category');
      return (
        <Combobox
          label={label}
          placeholder={placeholder}
          options={list}
          value={asString(value)}
          onChange={(next) => onChange(next)}
          valueIsId
          usePortal
        />
      );
    }
    case 'tagIds':
      return (
        <MultiSelect
          label={label}
          options={options.tags}
          value={asStrings(value)}
          onChange={onChange}
          placeholder={t('value.tags')}
        />
      );
    case 'enum': {
      const typeOptions: RuleOption[] = (spec.enumValues ?? []).map((v) => ({ value: v, label: t(`types.${v}`) }));
      if (shape === 'list') {
        return (
          <MultiSelect
            label={label}
            options={typeOptions}
            value={asStrings(value)}
            onChange={onChange}
            placeholder={t('value.types')}
            showSearch={false}
          />
        );
      }
      return (
        <Select id={id} label={label} options={typeOptions} value={asString(value)} onChange={(e) => onChange(e.target.value)} />
      );
    }
    case 'currency': {
      const codes = withSelected(options.currencyCodes, shape === 'list' ? asStrings(value) : [asString(value)]);
      if (shape === 'list') {
        return (
          <MultiSelect
            label={label}
            options={codes.map((code) => ({ value: code, label: code }))}
            value={asStrings(value)}
            onChange={onChange}
            placeholder={t('value.currencies')}
          />
        );
      }
      return (
        <Select
          id={id}
          label={label}
          value={asString(value)}
          onChange={(e) => onChange(e.target.value)}
          options={[{ value: '', label: t('value.currency') }, ...codes.map((code) => ({ value: code, label: code }))]}
        />
      );
    }
    case 'money': {
      // The calculator lets a minus sign through, so an unsigned field goes without it.
      const allowNegative = leaf.field !== 'absAmount';
      if (shape === 'range') {
        const [min, max] = asRange(value);
        return (
          <div className="grid grid-cols-2 gap-2">
            <CurrencyInput
              id={`${id}-from`}
              label={t('value.from')}
              value={min}
              allowNegative={allowNegative}
              allowCalculator={allowNegative}
              onChange={(next) => onChange([next, max])}
            />
            <CurrencyInput
              id={`${id}-to`}
              label={t('value.to')}
              value={max}
              allowNegative={allowNegative}
              allowCalculator={allowNegative}
              onChange={(next) => onChange([min, next])}
            />
          </div>
        );
      }
      return (
        <CurrencyInput
          id={id}
          label={t('value.amount')}
          value={asNumber(value)}
          allowNegative={allowNegative}
          allowCalculator={allowNegative}
          onChange={onChange}
        />
      );
    }
    case 'boolean':
      return (
        <div>
          <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>
          <div className="flex items-center gap-2 py-2">
            <ToggleSwitch checked={value === true} onChange={onChange} label={t('fields.hasSplits')} />
            <span className="text-sm text-gray-700 dark:text-gray-300">{value === true ? t('value.yes') : t('value.no')}</span>
          </div>
        </div>
      );
    default:
      return (
        <div>
          <Input
            id={id}
            label={label}
            value={asString(value)}
            maxLength={MAX_RULE_TEXT_LENGTH}
            onChange={(e) => onChange(e.target.value)}
          />
          {leaf.op === 'matches' && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('value.matchesHint')}</p>
          )}
        </div>
      );
  }
}
