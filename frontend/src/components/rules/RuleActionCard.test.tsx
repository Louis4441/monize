import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@/test/render';
import { RuleActionCard } from './RuleActionCard';
import { testOptions } from './rule-test-harness';
import { COFFEE_ID, PAYEE_ID, TAG_ID } from './rules-test-fixtures';
import { createAction, type EditorAction } from '@/lib/rule-actions';
import { RULE_ACTION_TYPES, MAX_RULE_AI_INSTRUCTION_LENGTH } from '@/lib/rule-fields';
import type { RuleActionType } from '@/types/transaction-rule';

Element.prototype.scrollIntoView = vi.fn();

function Card({
  initial,
  types = RULE_ACTION_TYPES,
  onAction,
  errors = [],
}: {
  initial: EditorAction;
  types?: readonly RuleActionType[];
  onAction?: (action: EditorAction) => void;
  errors?: string[];
}) {
  const [action, setAction] = useState(initial);
  return (
    <RuleActionCard
      action={action}
      types={types}
      options={testOptions}
      actions={[]}
      errors={errors}
      onChange={(next) => {
        setAction(next);
        onAction?.(next);
      }}
    />
  );
}

const optionLabels = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent);

describe('RuleActionCard', () => {
  it('lists the action types it is given, translated', () => {
    render(<Card initial={createAction('add_tags')} types={['add_tags', 'set_payee']} />);
    expect(optionLabels(screen.getByLabelText('Action type'))).toEqual(['Add tags', 'Set the payee']);
  });

  it('lists all five types when none is held back', () => {
    render(<Card initial={createAction('add_tags')} />);
    expect(optionLabels(screen.getByLabelText('Action type'))).toEqual([
      'Add tags',
      'Remove tags',
      'Set the category',
      'Set the payee',
      'Ask for an AI review',
    ]);
  });

  it('starts "Only if empty" on when the type is changed to set_category or set_payee', () => {
    const onAction = vi.fn();
    render(<Card initial={createAction('add_tags')} onAction={onAction} />);
    expect(screen.queryByRole('switch', { name: 'Only if empty' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Action type'), { target: { value: 'set_category' } });
    expect(screen.getByRole('switch', { name: 'Only if empty' })).toHaveAttribute('aria-checked', 'true');
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'set_category', onlyIfEmpty: true }));

    fireEvent.change(screen.getByLabelText('Action type'), { target: { value: 'set_payee' } });
    expect(screen.getByRole('switch', { name: 'Only if empty' })).toHaveAttribute('aria-checked', 'true');
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'set_payee', onlyIfEmpty: true }));
  });

  it('explains what "Only if empty" does not replace', () => {
    render(<Card initial={createAction('set_category')} />);
    const help = screen.getByRole('button', { name: /does not replace one set by hand or by the payee's default category/ });
    expect(help).toBeInTheDocument();
  });

  it('turns "Only if empty" off and keeps the choice', () => {
    const onAction = vi.fn();
    render(<Card initial={createAction('set_payee')} onAction={onAction} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Only if empty' }));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'set_payee', onlyIfEmpty: false }));
    expect(screen.getByRole('switch', { name: 'Only if empty' })).toHaveAttribute('aria-checked', 'false');
  });

  it('picks a category and a payee by name', () => {
    const onAction = vi.fn();
    const { unmount } = render(<Card initial={createAction('set_category')} onAction={onAction} />);
    fireEvent.focus(screen.getByPlaceholderText('Choose a category'));
    fireEvent.click(screen.getByText('Food: Coffee'));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ categoryId: COFFEE_ID, onlyIfEmpty: true }));
    unmount();

    render(<Card initial={createAction('set_payee')} onAction={onAction} />);
    fireEvent.focus(screen.getByPlaceholderText('Choose a payee'));
    fireEvent.click(screen.getByText('Corner Cafe'));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ payeeId: PAYEE_ID }));
  });

  it('picks tags for add_tags and remove_tags', () => {
    const onAction = vi.fn();
    render(<Card initial={createAction('remove_tags')} onAction={onAction} />);
    fireEvent.click(screen.getByText('Choose tags'));
    fireEvent.click(screen.getByLabelText('Coffee run'));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'remove_tags', tagIds: [TAG_ID] }));
  });

  it('takes the instruction of an AI review, bounded to what the server accepts', () => {
    const onAction = vi.fn();
    render(<Card initial={createAction('request_ai_review')} onAction={onAction} />);
    const box = screen.getByLabelText('What should be checked');
    expect(box).toHaveAttribute('maxlength', String(MAX_RULE_AI_INSTRUCTION_LENGTH));
    fireEvent.change(box, { target: { value: 'Split by the receipt' } });
    expect(onAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'request_ai_review', instruction: 'Split by the receipt' }),
    );
    expect(screen.getByText(/A person approves any change/)).toBeInTheDocument();
  });

  it('shows its errors on the card', () => {
    render(<Card initial={createAction('set_payee')} errors={['REFERENCE_NOT_FOUND']} />);
    expect(screen.getByRole('alert')).toHaveTextContent('An item chosen here no longer exists. Choose another.');
  });

  it('stacks its controls on a phone', () => {
    render(<Card initial={createAction('add_tags')} />);
    const grid = screen.getByLabelText('Action type').closest('.grid');
    expect(grid).toHaveClass('grid-cols-1');
  });
});
