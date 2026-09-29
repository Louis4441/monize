'use client';

import { memo, useCallback, useMemo, useState, type SyntheticEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from '@/components/ui/interactive-row';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { ruleInvalidReasonKeys, ruleSummaryValues } from '@/lib/rule-summary';
import type { TransactionRule } from '@/types/transaction-rule';

export type RuleMoveDirection = 'up' | 'down';

export interface RulesListProps {
  /** In evaluation order, exactly as the API answered. */
  rules: readonly TransactionRule[];
  /** Rules with a change in flight; their switch waits for the answer. */
  pendingIds: ReadonlySet<string>;
  /** True while a reorder is in flight; every move waits for it. */
  reordering: boolean;
  onToggle: (rule: TransactionRule, enabled: boolean) => void;
  onDuplicate: (rule: TransactionRule) => void;
  /** Open the manual-run dialog for the rule. */
  onRun: (rule: TransactionRule) => void;
  onMove: (rule: TransactionRule, direction: RuleMoveDirection) => void;
  onDelete: (rule: TransactionRule) => void;
}

/** A click on a control inside the row is that control's, not the row's. */
const keepInsideControl = (event: SyntheticEvent) => event.stopPropagation();

interface RuleRowProps {
  rule: TransactionRule;
  index: number;
  pending: boolean;
  actions: RowAction[];
  getRowHandlers: (rule: TransactionRule) => LongPressRowHandlers;
  onToggle: (rule: TransactionRule, enabled: boolean) => void;
  onOpen: (rule: TransactionRule) => void;
}

const RuleRow = memo(function RuleRow({
  rule,
  index,
  pending,
  actions,
  getRowHandlers,
  onToggle,
  onOpen,
}: RuleRowProps) {
  const t = useTranslations('rules');
  const format = useFormatter();
  const summary = t('list.summary', { ...ruleSummaryValues(rule) });

  const reasons = ruleInvalidReasonKeys(rule).map((key) => t(`invalid.reasons.${key}`));
  const invalidText = t('invalid.tooltip', { reasons: format.list(reasons, { type: 'conjunction' }) });

  return (
    <tr
      role="row"
      tabIndex={0}
      className={`group cursor-pointer select-none ${INTERACTIVE_ROW_FOCUS_CLASS} ${HOVER_ROW_ON_CARD}`}
      {...getRowHandlers(rule)}
      onKeyDown={(event) => {
        // Enter on the switch or a menu button is theirs, not the row's.
        if (event.target === event.currentTarget) activateOnKey(() => onOpen(rule))(event);
      }}
    >
      <Td className="hidden w-12 text-gray-500 dark:text-gray-400 sm:table-cell">{index + 1}</Td>
      <Td className="w-16">
        <div
          className="inline-flex"
          onClick={keepInsideControl}
          onMouseDown={keepInsideControl}
          onTouchStart={keepInsideControl}
          onContextMenu={keepInsideControl}
        >
          <ToggleSwitch
            checked={rule.enabled}
            disabled={pending}
            label={t('list.enabledLabel', { name: rule.name })}
            onChange={(next) => onToggle(rule, next)}
          />
        </div>
      </Td>
      <Td>
        <div
          className={`text-sm font-medium ${
            rule.enabled ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'
          }`}
        >
          {rule.name}
        </div>
        <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 sm:hidden">{summary}</div>
        {rule.invalid && (
          <div
            className="mt-1 inline-flex items-center gap-1"
            onClick={keepInsideControl}
            onMouseDown={keepInsideControl}
            onTouchStart={keepInsideControl}
          >
            <Badge variant="red" size="sm">
              {t('invalid.badge')}
            </Badge>
            <InfoTooltip text={invalidText} placement="top" usePortal />
          </div>
        )}
      </Td>
      <Td className="hidden text-gray-500 dark:text-gray-400 sm:table-cell">{summary}</Td>
      <Td align="right" className="hidden whitespace-nowrap font-medium min-[480px]:table-cell">
        <RowActions actions={actions} density="normal" maxInline={2} />
      </Td>
    </tr>
  );
});

/**
 * The rules in evaluation order, one row each. Reordering is a move up or down
 * in the row menu (no drag library); the order the reader sees is the order the
 * server holds, so a move waits for the server's answer instead of guessing.
 */
export function RulesList({
  rules,
  pendingIds,
  reordering,
  onToggle,
  onDuplicate,
  onRun,
  onMove,
  onDelete,
}: RulesListProps) {
  const t = useTranslations('rules');
  const tc = useTranslations('common');
  const router = useRouter();
  const [sheetRule, setSheetRule] = useState<TransactionRule | null>(null);

  const openRule = useCallback(
    (rule: TransactionRule) => router.push(`/rules/${rule.id}`),
    [router],
  );

  const { getRowHandlers } = useLongPress<TransactionRule>({
    onLongPress: setSheetRule,
    onClick: openRule,
  });

  const buildActions = useCallback(
    (rule: TransactionRule, index: number): RowAction[] => [
      { key: 'edit', label: tc('actions.edit'), icon: 'edit', tone: 'primary', onClick: () => openRule(rule) },
      { key: 'duplicate', label: tc('actions.duplicate'), icon: 'duplicate', tone: 'neutral', onClick: () => onDuplicate(rule) },
      {
        key: 'run',
        label: t('actions.run'),
        icon: 'post',
        tone: 'success',
        // An invalid rule is refused by the server; the editor explains why.
        disabled: rule.invalid,
        title: rule.invalid ? t('actions.runInvalid') : undefined,
        onClick: () => onRun(rule),
      },
      {
        key: 'moveUp',
        label: t('actions.moveUp'),
        icon: 'moveUp',
        tone: 'neutral',
        disabled: index === 0 || reordering,
        onClick: () => onMove(rule, 'up'),
      },
      {
        key: 'moveDown',
        label: t('actions.moveDown'),
        icon: 'moveDown',
        tone: 'neutral',
        disabled: index === rules.length - 1 || reordering,
        onClick: () => onMove(rule, 'down'),
      },
      { key: 'delete', label: tc('actions.delete'), icon: 'delete', tone: 'delete', destructive: true, onClick: () => onDelete(rule) },
    ],
    [t, tc, rules.length, reordering, openRule, onDuplicate, onRun, onMove, onDelete],
  );

  const rowActions = useMemo(() => rules.map((rule, index) => buildActions(rule, index)), [rules, buildActions]);
  // The sheet shows the rule as the list holds it now, not as it was pressed.
  const sheetIndex = sheetRule ? rules.findIndex((r) => r.id === sheetRule.id) : -1;
  const sheetCurrent = sheetIndex >= 0 ? rules[sheetIndex] : null;

  return (
    <div className="overflow-x-auto">
      <table className={TABLE_CLASS}>
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <Th className="hidden sm:table-cell">{t('list.header.order')}</Th>
            <Th>{t('list.header.enabled')}</Th>
            <Th>{t('list.header.name')}</Th>
            <Th className="hidden sm:table-cell">{t('list.header.summary')}</Th>
            <Th align="right" className="hidden min-[480px]:table-cell">
              {t('list.header.actions')}
            </Th>
          </tr>
        </thead>
        <tbody className={TABLE_BODY_CLASS}>
          {rules.map((rule, index) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              index={index}
              pending={pendingIds.has(rule.id)}
              actions={rowActions[index]}
              getRowHandlers={getRowHandlers}
              onToggle={onToggle}
              onOpen={openRule}
            />
          ))}
        </tbody>
      </table>
      <RowActionSheet
        isOpen={sheetCurrent !== null}
        title={sheetCurrent?.name ?? ''}
        actions={sheetCurrent ? buildActions(sheetCurrent, sheetIndex) : []}
        onClose={() => setSheetRule(null)}
      />
    </div>
  );
}
