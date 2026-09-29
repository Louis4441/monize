'use client';

import { useTranslations } from 'next-intl';
import { RuleCardShell } from '@/components/rules/RuleCardShell';
import { RuleValueControl } from '@/components/rules/RuleValueControl';
import type { RuleOptions } from '@/components/rules/use-rule-options';
import { Select } from '@/components/ui/Select';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import {
  EDITOR_RULE_FIELDS,
  RULE_CONDITION_FIELDS,
  isEditorRuleField,
  isRuleField,
  isRuleOperator,
} from '@/lib/rule-fields';
import { changeLeafField, changeLeafOperator, type EditorLeaf } from '@/lib/rule-tree';

interface RuleConditionCardProps {
  leaf: EditorLeaf;
  options: RuleOptions;
  actions: RowAction[];
  errors: readonly string[];
  onChange: (leaf: EditorLeaf) => void;
}

/**
 * One condition: field, operator, value. The operator list is the field's own
 * (`RULE_CONDITION_FIELDS`), and picking another field starts the operator and
 * value over, because the old ones meant something else. On a phone the three
 * controls stack; from `sm` they sit side by side.
 */
export function RuleConditionCard({ leaf, options, actions, errors, onChange }: RuleConditionCardProps) {
  const t = useTranslations('rules.editor');
  const operators = RULE_CONDITION_FIELDS[leaf.field].operators;

  return (
    <RuleCardShell label={t('condition.title')} actions={actions} errors={errors}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)]">
        <Select
          id={`${leaf.uid}-field`}
          label={t('condition.field')}
          value={leaf.field}
          options={[
            ...EDITOR_RULE_FIELDS.map((field) => ({ value: field, label: t(`fields.${field}`) })),
            // A field whose card is task X5 keeps its own name until then; it is never hidden or reset.
            ...(isEditorRuleField(leaf.field) ? [] : [{ value: leaf.field, label: leaf.field }]),
          ]}
          onChange={(e) => {
            if (isRuleField(e.target.value)) onChange(changeLeafField(leaf, e.target.value));
          }}
        />
        <Select
          id={`${leaf.uid}-operator`}
          label={t('condition.operator')}
          value={leaf.op}
          options={operators.map((op) => ({ value: op, label: t(`operators.${op}`) }))}
          onChange={(e) => {
            if (isRuleOperator(e.target.value)) onChange(changeLeafOperator(leaf, e.target.value));
          }}
        />
        <RuleValueControl leaf={leaf} options={options} onChange={(value) => onChange({ ...leaf, value })} />
      </div>
    </RuleCardShell>
  );
}
