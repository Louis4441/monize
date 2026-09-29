import { describe, expect, it } from 'vitest';
import { makeRule } from '@/components/rules/rules-test-fixtures';
import { createAction } from './rule-actions';
import {
  actionToApi,
  conditionToApi,
  draftFromRule,
  draftSignature,
  draftToPayload,
  emptyDraft,
} from './rule-draft';
import { createGroup, createLeaf, type EditorGroup, type EditorLeaf } from './rule-tree';
import type { TransactionRule } from '@/types/transaction-rule';

const UUID = '11111111-1111-4111-8111-111111111111';

const read = (over: Partial<TransactionRule>) => draftFromRule(makeRule(over));

describe('emptyDraft', () => {
  it('is an enabled rule for both triggers that matches everything and does nothing yet', () => {
    const draft = emptyDraft();
    expect(draft).toMatchObject({ name: '', enabled: true, triggers: ['create', 'import'], stopProcessing: false });
    expect(draft.condition.children).toEqual([]);
    expect(draft.actions).toEqual([]);
  });
});

describe('draftFromRule: the X3 fields', () => {
  it('keeps a condition on a field the editor has no card for, values and operators intact', () => {
    const condition = {
      all: [
        { field: 'dayOfMonth', op: 'in', value: [1, 15] },
        { field: 'dayOfMonth', op: 'between', value: [10, 20] },
        { field: 'dayOfMonth', op: 'gte', value: 28 },
        { field: 'weekday', op: 'in', value: ['SAT', 'SUN'] },
        { field: 'status', op: 'neq', value: 'VOID' },
        { field: 'hasAttachment', op: 'eq', value: false },
        { field: 'referenceNumber', op: 'isEmpty' },
        { field: 'referenceNumber', op: 'matches', value: 'CHK-{n}' },
      ],
    };
    const { draft, repaired } = read({ condition: condition as never });
    expect(repaired).toBe(0);
    expect(conditionToApi(draft.condition)).toEqual(condition);
  });
});

describe('draftFromRule', () => {
  it('reads a valid rule without repairing anything', () => {
    const { draft, repaired } = draftFromRule(makeRule());
    expect(repaired).toBe(0);
    expect(draft.name).toBe('Coffee shops');
    expect(draft.condition).toMatchObject({ kind: 'group', match: 'all', not: false });
    expect(draft.condition.children[0]).toMatchObject({ kind: 'leaf', field: 'memo', op: 'contains', value: 'coffee' });
    expect(draft.actions.map((a) => a.type)).toEqual(['add_tags', 'set_payee']);
  });

  it('round-trips a nested rule through the editor and back to the same JSON', () => {
    const condition = {
      all: [
        { field: 'type', op: 'eq', value: 'TRANSFER' },
        { any: [{ field: 'amount', op: 'between', value: [-500, -100] }, { field: 'memo', op: 'isEmpty' }], not: true },
      ],
    };
    const actions = [
      { type: 'set_category', categoryId: UUID, onlyIfEmpty: false },
      { type: 'remove_tags', tagIds: [UUID] },
      { type: 'request_ai_review', instruction: 'Check the split' },
    ];
    const { draft, repaired } = read({ condition, actions } as Partial<TransactionRule>);
    expect(repaired).toBe(0);
    expect(conditionToApi(draft.condition)).toEqual(condition);
    expect(draft.actions.map(actionToApi)).toEqual(actions);
  });

  it('wraps a bare leaf in a group', () => {
    const { draft, repaired } = read({ condition: { field: 'memo', op: 'eq', value: 'x' } });
    expect(repaired).toBe(0);
    expect(draft.condition.children).toHaveLength(1);
  });

  it('opens an unreadable definition as an empty one and counts the repairs', () => {
    const { draft, repaired } = read({ condition: {} as never, actions: [] });
    expect(draft.condition.children).toEqual([]);
    expect(draft.actions).toEqual([]);
    expect(repaired).toBeGreaterThan(0);
  });

  it('drops parts it cannot read and resets a leaf whose operator the field does not allow', () => {
    const condition = {
      all: [
        { field: 'nope', op: 'eq', value: 'x' },
        'text',
        { field: 'type', op: 'contains', value: 'x' },
        { field: 'memo', op: 'eq', value: 5 },
        { field: 'amount', op: 'between', value: [1] },
        { field: 'memo', op: 'isEmpty', value: 'stray' },
        { all: 'not a list' },
        { all: [], any: [] },
      ],
    };
    const { draft, repaired } = read({ condition } as never);
    expect(repaired).toBe(8);
    const kinds = draft.condition.children.map((c) => (c.kind === 'leaf' ? `${c.field}:${c.op}` : `group:${c.match}`));
    expect(kinds).toEqual(['type:eq', 'memo:eq', 'amount:between', 'memo:isEmpty', 'group:all']);
    expect((draft.condition.children[1] as EditorLeaf).value).toBe('');
    expect((draft.condition.children[3] as EditorLeaf).value).toBeUndefined();
  });

  it('repairs actions: unknown types dropped, missing parameters blank, missing flag on', () => {
    const actions = [
      { type: 'delete_everything' },
      null,
      { type: 'add_tags', tagIds: 'x' },
      { type: 'set_category' },
      { type: 'set_payee', payeeId: UUID },
      { type: 'request_ai_review' },
    ];
    const { draft, repaired } = read({ actions } as never);
    expect(repaired).toBe(5);
    expect(draft.actions).toMatchObject([
      { type: 'add_tags', tagIds: [] },
      { type: 'set_category', categoryId: '', onlyIfEmpty: true },
      { type: 'set_payee', payeeId: UUID, onlyIfEmpty: true },
      { type: 'request_ai_review', instruction: '' },
    ]);
  });

  it('counts actions that are not a list', () => {
    const { draft, repaired } = read({ actions: 'x' as never });
    expect(draft.actions).toEqual([]);
    expect(repaired).toBe(1);
  });

  it('keeps only known triggers, in the server order', () => {
    expect(read({ triggers: ['import', 'create', 'manual'] as never }).draft.triggers).toEqual(['create', 'import']);
    expect(read({ triggers: undefined as never }).draft.triggers).toEqual([]);
  });

  it('reads flags strictly and tolerates a missing name', () => {
    const { draft } = read({ name: undefined as never, enabled: undefined as never, stopProcessing: true });
    expect(draft).toMatchObject({ name: '', enabled: false, stopProcessing: true });
  });
});

describe('draftToPayload', () => {
  it('sends exactly the fields the DTO accepts, with the name trimmed', () => {
    const draft = { ...emptyDraft(), name: '  Rent  ', actions: [{ ...createAction('add_tags'), tagIds: [UUID] } as never] };
    expect(draftToPayload(draft)).toEqual({
      name: 'Rent',
      enabled: true,
      triggers: ['create', 'import'],
      condition: { all: [] },
      actions: [{ type: 'add_tags', tagIds: [UUID] }],
      stopProcessing: false,
    });
  });

  it('writes not only when it is on, any groups as any, and omits the value of isEmpty', () => {
    const empty: EditorLeaf = { ...createLeaf('memo'), op: 'isEmpty', value: undefined };
    const group: EditorGroup = { ...createGroup('any', [empty]), not: true };
    expect(conditionToApi(group)).toEqual({ any: [{ field: 'memo', op: 'isEmpty' }], not: true });
    expect(conditionToApi(createGroup('all'))).toEqual({ all: [] });
  });

  it('writes every action type in its DTO shape, onlyIfEmpty included', () => {
    expect(actionToApi({ uid: 'u', type: 'set_category', categoryId: UUID, onlyIfEmpty: false })).toEqual({
      type: 'set_category',
      categoryId: UUID,
      onlyIfEmpty: false,
    });
    expect(actionToApi({ uid: 'u', type: 'set_payee', payeeId: UUID, onlyIfEmpty: true })).toEqual({
      type: 'set_payee',
      payeeId: UUID,
      onlyIfEmpty: true,
    });
    expect(actionToApi({ uid: 'u', type: 'request_ai_review', instruction: 'x' })).toEqual({
      type: 'request_ai_review',
      instruction: 'x',
    });
    expect(actionToApi({ uid: 'u', type: 'remove_tags', tagIds: [UUID] })).toEqual({ type: 'remove_tags', tagIds: [UUID] });
  });

  it('gives two drafts that would save the same rule the same signature, whatever their identities', () => {
    const a = draftFromRule(makeRule()).draft;
    const b = draftFromRule(makeRule()).draft;
    expect(a.condition.uid).not.toBe(b.condition.uid);
    expect(draftSignature(a)).toBe(draftSignature(b));
    expect(draftSignature({ ...a, name: 'Other' })).not.toBe(draftSignature(a));
    expect(draftSignature({ ...a, name: ' Coffee shops ' })).toBe(draftSignature(a));
  });
});
