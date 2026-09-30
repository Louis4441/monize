'use client';

import { useTranslations } from 'next-intl';
import { RuleSection } from '@/components/rules/RuleSection';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { RuleTrigger } from '@/types/transaction-rule';

interface RuleWhenSectionProps {
  triggers: readonly RuleTrigger[];
  stopProcessing: boolean;
  onTriggersChange: (triggers: readonly RuleTrigger[]) => void;
  onStopProcessingChange: (next: boolean) => void;
}

const TRIGGER_LABEL_KEYS = { create: 'created', import: 'imported' } as const;

/**
 * "When": which events the rule looks at, and whether a match ends the run for
 * that transaction. At least one trigger stays checked (the server refuses a
 * rule that never runs), so the last checked box is disabled.
 */
export function RuleWhenSection({
  triggers,
  stopProcessing,
  onTriggersChange,
  onStopProcessingChange,
}: RuleWhenSectionProps) {
  const t = useTranslations('rules.editor');
  const onlyOne = triggers.length === 1;

  const toggle = (trigger: RuleTrigger, checked: boolean) =>
    onTriggersChange(checked ? [...triggers, trigger] : triggers.filter((x) => x !== trigger));

  return (
    <RuleSection
      title={t('sections.when')}
      description={t('when.description')}
      anchor={tourAnchor(TOUR_ANCHORS.ruleEditorWhen)}
    >
      <div className="space-y-2">
        {(['create', 'import'] as const).map((trigger) => {
          const checked = triggers.includes(trigger);
          return (
            <label key={trigger} className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
                checked={checked}
                disabled={checked && onlyOne}
                onChange={(e) => toggle(trigger, e.target.checked)}
              />
              {t(`when.${TRIGGER_LABEL_KEYS[trigger]}`)}
            </label>
          );
        })}
        {onlyOne && <p className="text-xs text-gray-500 dark:text-gray-400">{t('when.atLeastOne')}</p>}
      </div>
      <div className="mt-4 flex items-center gap-2 border-t border-gray-200 pt-4 dark:border-gray-700">
        <ToggleSwitch checked={stopProcessing} onChange={onStopProcessingChange} label={t('when.stopProcessing')} />
        <span className="text-sm text-gray-800 dark:text-gray-200">{t('when.stopProcessing')}</span>
        <InfoTooltip text={t('when.stopProcessingHelp')} placement="top" usePortal />
      </div>
    </RuleSection>
  );
}
