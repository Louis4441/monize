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

export const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
export const JOINT_ACCOUNT_ID = '11111111-1111-4111-8111-222222222222';
export const PAYEE_ID = '22222222-2222-4222-8222-222222222222';
export const FOOD_ID = '33333333-3333-4333-8333-333333333333';
export const COFFEE_ID = '33333333-3333-4333-8333-444444444444';
export const TAG_ID = '44444444-4444-4444-8444-444444444444';
export const TAG_WORK_ID = '44444444-4444-4444-8444-555555555555';

/** What the pickers' five list endpoints answer in the editor tests. */
export const lookupFixtures = {
  accounts: [
    { id: ACCOUNT_ID, name: 'Chequing', currencyCode: 'CAD', isClosed: false, isJoint: false },
    { id: JOINT_ACCOUNT_ID, name: 'Partner joint', currencyCode: 'CAD', isClosed: false, isJoint: true },
  ],
  payees: [{ id: PAYEE_ID, name: 'Corner Cafe' }],
  categories: [
    { id: FOOD_ID, name: 'Food', parentId: null },
    { id: COFFEE_ID, name: 'Coffee', parentId: FOOD_ID },
  ],
  tags: [
    { id: TAG_ID, name: 'Coffee run' },
    { id: TAG_WORK_ID, name: 'Work' },
  ],
  currencies: [
    { code: 'CAD', isActive: true },
    { code: 'USD', isActive: true },
    { code: 'EUR', isActive: false },
  ],
};
