import type { TransactionRule } from '@/types/transaction-rule';

/** A valid stored rule; a case overrides only what it is about. */
export function makeRule(overrides: Partial<TransactionRule> = {}): TransactionRule {
  return {
    id: 'rule-1',
    name: 'Coffee shops',
    enabled: true,
    position: 0,
    triggers: ['create'],
    condition: { all: [{ field: 'memo', op: 'contains', value: 'coffee' }] },
    actions: [
      { type: 'add_tags', tagIds: ['tag-1'] },
      { type: 'set_payee', payeeId: 'payee-1', onlyIfEmpty: true },
    ],
    stopProcessing: false,
    revision: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    invalid: false,
    invalidReasons: [],
    ...overrides,
  };
}
