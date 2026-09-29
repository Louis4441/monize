'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { RuleActionCard } from '@/components/rules/RuleActionCard';
import { RuleConditionGroup, type RuleTreeEnv } from '@/components/rules/RuleConditionGroup';
import { RuleEditorBanners } from '@/components/rules/RuleEditorBanners';
import { RuleErrorList } from '@/components/rules/RuleCardShell';
import { RuleApplications } from '@/components/rules/RuleApplications';
import { RuleSection } from '@/components/rules/RuleSection';
import { RuleTestPanel } from '@/components/rules/RuleTestPanel';
import { RunRuleDialog } from '@/components/rules/RunRuleDialog';
import { RuleWhenSection } from '@/components/rules/RuleWhenSection';
import { createTreeHandlers } from '@/components/rules/rule-tree-handlers';
import { useCardActions } from '@/components/rules/use-rule-card-actions';
import { useRuleErrorMessage } from '@/components/rules/use-rule-error-message';
import { useRuleOptions } from '@/components/rules/use-rule-options';
import { Button, buttonClassName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { RuleLookups } from '@/hooks/useRuleLookups';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import {
  availableActionTypes,
  canAddAction,
  canDuplicateAction,
  canMoveAction,
  createAction,
  duplicateAction,
  moveAction,
  removeAction,
  updateAction,
  actionKey,
} from '@/lib/rule-actions';
import { draftFromRule, draftSignature, draftToPayload, emptyDraft, type RuleDraft } from '@/lib/rule-draft';
import {
  ACTIONS_LIST_KEY,
  NAME_KEY,
  NO_ERRORS,
  draftGaps,
  isRevisionConflict,
  placeErrors,
  readRuleApiError,
  type PlacedErrors,
} from '@/lib/rule-errors';
import { MAX_RULE_ACTIONS, MAX_RULE_NAME_LENGTH } from '@/lib/rule-fields';
import { treeCapacity, type EditorGroup } from '@/lib/rule-tree';
import { transactionRulesApi } from '@/lib/transaction-rules-api';
import type { TransactionRule } from '@/types/transaction-rule';

const logger = createLogger('RuleEditor');

interface RuleEditorBodyProps {
  /** The stored rule being edited; null for a new one. */
  rule: TransactionRule | null;
  lookups: RuleLookups;
  /** An existing rule was saved; the parent adopts the answer. */
  onSaved: (rule: TransactionRule) => void;
  /** Fetch the rule again (after a revision conflict). */
  onReload: () => void;
}

/**
 * The editor proper: the draft, its four panels and the save. The draft is
 * local until Save; Save is the one write, and while it is in flight the whole
 * form is disabled so an answer can only ever describe the draft that was sent.
 *
 * Errors follow the draft: the ones a save brought back stay on their cards
 * until the next edit, because after an edit their paths may point elsewhere.
 */
export function RuleEditorBody({ rule, lookups, onSaved, onReload }: RuleEditorBodyProps) {
  const t = useTranslations('rules.editor');
  const tc = useTranslations('common');
  const router = useRouter();
  const options = useRuleOptions(lookups);
  const cardActions = useCardActions();
  const errorMessage = useRuleErrorMessage();

  const [initial] = useState(() => (rule ? draftFromRule(rule) : { draft: emptyDraft(), repaired: 0 }));
  const [draft, setDraft] = useState<RuleDraft>(initial.draft);
  // A repaired definition differs from what is stored, so it is always saveable.
  const [baseline] = useState(() => (initial.repaired > 0 ? null : draftSignature(initial.draft)));
  const [errors, setErrors] = useState<PlacedErrors>(() =>
    rule?.invalid ? placeErrors(rule.invalidReasons) : NO_ERRORS,
  );
  const [refused, setRefused] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runOpen, setRunOpen] = useState(false);

  const dirty = baseline === null || draftSignature(draft) !== baseline;

  const edit = (fn: (current: RuleDraft) => RuleDraft) => {
    setDraft(fn);
    setErrors(NO_ERRORS);
    setRefused(false);
    setMessage(null);
  };
  const editCondition = (fn: (root: EditorGroup) => EditorGroup) =>
    edit((current) => ({ ...current, condition: fn(current.condition) }));

  const handlers = createTreeHandlers(editCondition);

  const env: RuleTreeEnv = {
    root: draft.condition,
    options,
    errors: errors.byKey,
    capacity: treeCapacity(draft.condition),
    handlers,
  };

  const setActions = (fn: (actions: RuleDraft['actions']) => RuleDraft['actions']) =>
    edit((current) => ({ ...current, actions: fn(current.actions) }));

  const fail = (entries: Parameters<typeof placeErrors>[0], text: string | null) => {
    setErrors(placeErrors(entries));
    setRefused(entries.length > 0);
    setMessage(text);
  };

  const save = async () => {
    const gaps = draftGaps(draft);
    if (gaps.length > 0) {
      fail(gaps, null);
      return;
    }
    setSaving(true);
    try {
      const payload = draftToPayload(draft);
      if (rule) {
        const saved = await transactionRulesApi.update(rule.id, { ...payload, revision: rule.revision });
        toast.success(t('save.savedToast'));
        onSaved(saved);
      } else {
        const saved = await transactionRulesApi.create(payload);
        toast.success(t('save.createdToast'));
        router.replace(`/rules/${saved.id}`);
      }
    } catch (error) {
      const api = readRuleApiError(error);
      if (isRevisionConflict(api)) {
        setConflict(true);
      } else if (api.entries.length > 0) {
        fail(api.entries, null);
      } else {
        fail([], getErrorMessage(error, t('save.failedToast')));
        logger.error(error);
      }
    } finally {
      setSaving(false);
    }
  };

  const nameErrors = errors.byKey[NAME_KEY] ?? [];
  const listErrors = errors.byKey[ACTIONS_LIST_KEY] ?? [];
  const noConditions = draft.condition.children.length === 0;

  return (
    <div className="space-y-6">
      <RuleEditorBanners
        rule={rule}
        repaired={initial.repaired}
        conflict={conflict}
        onReload={onReload}
        refused={refused}
        unplaced={errors.unplaced}
        message={message}
      />
      <fieldset disabled={saving} aria-busy={saving} className="m-0 min-w-0 space-y-6 border-0 p-0">
        <Card padding="md">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <Input
                id="rule-name"
                label={t('name.label')}
                value={draft.name}
                maxLength={MAX_RULE_NAME_LENGTH}
                placeholder={t('name.placeholder')}
                error={nameErrors[0] ? errorMessage(nameErrors[0]) : undefined}
                onChange={(e) => edit((current) => ({ ...current, name: e.target.value }))}
              />
            </div>
            <div className="flex items-center gap-2 pb-2">
              <ToggleSwitch
                checked={draft.enabled}
                label={t('enabled.label')}
                onChange={(enabled) => edit((current) => ({ ...current, enabled }))}
              />
              <span className="text-sm text-gray-800 dark:text-gray-200">{t('enabled.label')}</span>
            </div>
          </div>
        </Card>

        <RuleWhenSection
          triggers={draft.triggers}
          stopProcessing={draft.stopProcessing}
          onTriggersChange={(triggers) => edit((current) => ({ ...current, triggers }))}
          onStopProcessingChange={(stopProcessing) => edit((current) => ({ ...current, stopProcessing }))}
        />

        <RuleSection title={t('sections.if')} description={t('if.description')}>
          {noConditions && (
            <p className="mb-3 flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
              <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {t('if.everyTransaction')}
            </p>
          )}
          <RuleConditionGroup group={draft.condition} path={[]} env={env} />
        </RuleSection>

        <RuleSection title={t('sections.then')} description={t('then.description')}>
          <div className="space-y-3">
            {draft.actions.length === 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('then.empty')}</p>
            )}
            {draft.actions.map((action, index) => (
              <RuleActionCard
                key={action.uid}
                action={action}
                types={availableActionTypes(draft.actions, index)}
                options={options}
                errors={errors.byKey[actionKey(index)] ?? []}
                onChange={(next) => setActions((list) => updateAction(list, index, next))}
                actions={cardActions({
                  canDuplicate: canDuplicateAction(draft.actions, index),
                  canMoveUp: canMoveAction(draft.actions, index, -1),
                  canMoveDown: canMoveAction(draft.actions, index, 1),
                  onDuplicate: () => setActions((list) => duplicateAction(list, index)),
                  onMoveUp: () => setActions((list) => moveAction(list, index, -1)),
                  onMoveDown: () => setActions((list) => moveAction(list, index, 1)),
                  onDelete: () => setActions((list) => removeAction(list, index)),
                })}
              />
            ))}
            <RuleErrorList errors={listErrors} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canAddAction(draft.actions)}
              onClick={() => setActions((list) => [...list, createAction()])}
            >
              {t('action.add')}
            </Button>
            {!canAddAction(draft.actions) && (
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('then.limit', { max: MAX_RULE_ACTIONS })}</p>
            )}
          </div>
        </RuleSection>

        <RuleTestPanel draft={draft} accountOptions={options.accounts} />

        {rule && <RuleApplications ruleId={rule.id} options={options} />}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
          {rule && (
            <div className="flex flex-col gap-1 sm:mr-auto">
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                disabled={saving || dirty}
                onClick={() => setRunOpen(true)}
              >
                {t('run.button')}
              </Button>
              {dirty && <p className="text-xs text-gray-500 dark:text-gray-400">{t('run.saveFirst')}</p>}
            </div>
          )}
          <Link href="/rules" className={buttonClassName('outline', 'md', 'w-full sm:w-auto')}>
            {tc('cancel')}
          </Link>
          <Button
            type="button"
            className="w-full sm:w-auto"
            isLoading={saving}
            disabled={saving || (rule !== null && !dirty)}
            onClick={() => void save()}
          >
            {t('save.button')}
          </Button>
        </div>
      </fieldset>
      <RunRuleDialog
        rule={runOpen && rule ? { id: rule.id, name: rule.name } : null}
        accountOptions={options.accounts}
        onClose={() => setRunOpen(false)}
      />
    </div>
  );
}
