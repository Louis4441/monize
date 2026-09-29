import { describe, expect, it } from 'vitest';
import {
  availableActionTypes,
  canAddAction,
  canDuplicateAction,
  canMoveAction,
  changeActionType,
  createAction,
  duplicateAction,
  moveAction,
  removeAction,
  updateAction,
  type EditorAction,
} from './rule-actions';
import { MAX_RULE_ACTIONS } from './rule-fields';

const many = (n: number): EditorAction[] => Array.from({ length: n }, () => createAction('add_tags'));

describe('createAction', () => {
  it('starts set_category and set_payee with onlyIfEmpty on', () => {
    expect(createAction('set_category')).toMatchObject({ categoryId: '', onlyIfEmpty: true });
    expect(createAction('set_payee')).toMatchObject({ payeeId: '', onlyIfEmpty: true });
  });

  it('starts the other types blank', () => {
    expect(createAction()).toMatchObject({ type: 'add_tags', tagIds: [] });
    expect(createAction('remove_tags')).toMatchObject({ type: 'remove_tags', tagIds: [] });
    expect(createAction('request_ai_review')).toMatchObject({ instruction: '' });
  });

  it('keeps the card when its type changes, and its parameters start over', () => {
    const tags = { ...createAction('add_tags'), tagIds: ['t1'] } as EditorAction;
    const category = changeActionType(tags, 'set_category');
    expect(category).toMatchObject({ type: 'set_category', uid: tags.uid, onlyIfEmpty: true });
    expect(changeActionType(tags, 'add_tags')).toBe(tags);
  });
});

describe('limits', () => {
  it('allows at most MAX_RULE_ACTIONS actions and no duplicate past it', () => {
    expect(canAddAction(many(MAX_RULE_ACTIONS - 1))).toBe(true);
    expect(canAddAction(many(MAX_RULE_ACTIONS))).toBe(false);
    expect(canDuplicateAction(many(MAX_RULE_ACTIONS), 0)).toBe(false);
    expect(duplicateAction(many(MAX_RULE_ACTIONS), 0)).toHaveLength(MAX_RULE_ACTIONS);
  });

  it('offers request_ai_review only to the card that is one, or while none is', () => {
    const list = [createAction('add_tags'), createAction('request_ai_review')];
    expect(availableActionTypes(list, 0)).not.toContain('request_ai_review');
    expect(availableActionTypes(list, 1)).toContain('request_ai_review');
    expect(availableActionTypes([createAction('add_tags')], 0)).toContain('request_ai_review');
  });

  it('never duplicates an AI review', () => {
    const list = [createAction('request_ai_review')];
    expect(canDuplicateAction(list, 0)).toBe(false);
    expect(duplicateAction(list, 0)).toBe(list);
    expect(canDuplicateAction(list, 4)).toBe(false);
  });
});

describe('list edits', () => {
  it('updates and removes by index without mutating', () => {
    const list = many(3);
    const changed = updateAction(list, 1, { ...list[1], type: 'add_tags', tagIds: ['x'] });
    expect(changed[1]).toMatchObject({ tagIds: ['x'] });
    expect(list[1]).toMatchObject({ tagIds: [] });
    expect(removeAction(list, 0).map((a) => a.uid)).toEqual([list[1].uid, list[2].uid]);
  });

  it('moves a card and stops at the ends', () => {
    const list = many(3);
    expect(canMoveAction(list, 0, -1)).toBe(false);
    expect(canMoveAction(list, 2, 1)).toBe(false);
    expect(canMoveAction(list, 5, 1)).toBe(false);
    expect(moveAction(list, 0, -1)).toBe(list);
    expect(moveAction(list, 0, 1).map((a) => a.uid)).toEqual([list[1].uid, list[0].uid, list[2].uid]);
  });

  it('duplicates a card right after itself with a new identity', () => {
    const list = many(2);
    const next = duplicateAction(list, 0);
    expect(next).toHaveLength(3);
    expect(next[1].uid).not.toBe(list[0].uid);
    expect(next[1]).toMatchObject({ type: 'add_tags' });
    expect(next[2].uid).toBe(list[1].uid);
  });
});
