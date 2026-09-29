import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@/test/render';
import { RuleConditionCard } from './RuleConditionCard';
import { testOptions } from './rule-test-harness';
import { ACCOUNT_ID, COFFEE_ID, TAG_ID } from './rules-test-fixtures';
import en from '@/i18n/messages/en/rules.json';
import { RULE_CONDITION_FIELDS } from '@/lib/rule-fields';
import { createLeaf, type EditorLeaf } from '@/lib/rule-tree';

Element.prototype.scrollIntoView = vi.fn();

function Card({ initial, onLeaf }: { initial: EditorLeaf; onLeaf?: (leaf: EditorLeaf) => void }) {
  const [leaf, setLeaf] = useState(initial);
  return (
    <RuleConditionCard
      leaf={leaf}
      options={testOptions}
      actions={[]}
      errors={[]}
      onChange={(next) => {
        setLeaf(next);
        onLeaf?.(next);
      }}
    />
  );
}

const leaf = (over: Partial<EditorLeaf>): EditorLeaf => ({ ...createLeaf('memo'), ...over });
const optionLabels = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent);

describe('RuleConditionCard', () => {
  it.each(Object.entries(RULE_CONDITION_FIELDS))('offers only the operators of %s', (field, spec) => {
    render(<Card initial={createLeaf(field as EditorLeaf['field'])} />);
    expect(optionLabels(screen.getByLabelText('Operator'))).toEqual(
      spec.operators.map((op) => en.editor.operators[op]),
    );
  });

  it('lists every field, in the table order', () => {
    render(<Card initial={leaf({})} />);
    expect(optionLabels(screen.getByLabelText('Field'))).toEqual(
      Object.keys(RULE_CONDITION_FIELDS).map((field) => en.editor.fields[field as keyof typeof en.editor.fields]),
    );
  });

  it('starts over when the field changes: first operator of the new field, empty value', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'amount', op: 'between', value: [1, 2] })} onLeaf={onLeaf} />);

    fireEvent.change(screen.getByLabelText('Field'), { target: { value: 'memo' } });

    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ field: 'memo', op: 'eq', value: '' }));
    expect(screen.getByLabelText('Operator')).toHaveValue('eq');
    expect(screen.getByLabelText('Value')).toHaveValue('');
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
  });

  it('keeps a pick across operators of the same shape and swaps the control across shapes', () => {
    render(<Card initial={leaf({ field: 'payeeId', op: 'eq', value: '' })} />);
    expect(screen.getByPlaceholderText('Choose a payee')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Operator'), { target: { value: 'in' } });
    expect(screen.queryByPlaceholderText('Choose a payee')).not.toBeInTheDocument();
    expect(screen.getByText('Choose payees')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Operator'), { target: { value: 'isEmpty' } });
    expect(screen.queryByText('Choose payees')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument();
  });

  it('shows a picker with names for accounts, payees and categories, never an id', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'accountId', op: 'eq', value: ACCOUNT_ID })} onLeaf={onLeaf} />);
    const input = screen.getByPlaceholderText('Choose an account');
    expect(input).toHaveValue('Chequing (CAD)');
    expect(screen.queryByDisplayValue(ACCOUNT_ID)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Field'), { target: { value: 'categoryId' } });
    fireEvent.focus(screen.getByPlaceholderText('Choose a category'));
    fireEvent.click(screen.getByText('Food: Coffee'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ field: 'categoryId', value: COFFEE_ID }));
  });

  it('offers inSubtree only for categories and reads it as a single pick', () => {
    render(<Card initial={leaf({ field: 'categoryId', op: 'inSubtree', value: '' })} />);
    expect(screen.getByLabelText('Operator')).toHaveValue('inSubtree');
    expect(screen.getByPlaceholderText('Choose a category')).toBeInTheDocument();
  });

  it('uses a multi-select for a list of accounts and reports the chosen ids', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'accountId', op: 'in', value: [] })} onLeaf={onLeaf} />);
    fireEvent.click(screen.getByText('Choose accounts'));
    fireEvent.click(screen.getByLabelText('Chequing (CAD)'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: [ACCOUNT_ID] }));
  });

  it('uses a multi-select over tags', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'tagIds', op: 'hasAny', value: [] })} onLeaf={onLeaf} />);
    fireEvent.click(screen.getByText('Choose tags'));
    fireEvent.click(screen.getByLabelText('Coffee run'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: [TAG_ID] }));
  });

  it('uses a text input, and explains the wildcard only for the pattern operator', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'description', op: 'contains', value: '' })} onLeaf={onLeaf} />);
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'coffee' } });
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'coffee' }));
    expect(screen.queryByText(/wildcard/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Operator'), { target: { value: 'matches' } });
    expect(screen.getByText(/Use \* as a wildcard/)).toBeInTheDocument();
    expect(screen.getByLabelText('Value')).toHaveValue('coffee');
  });

  it('uses a money input for an amount and two for a range', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'amount', op: 'gt' })} onLeaf={onLeaf} />);
    const amount = screen.getByLabelText('Amount');
    fireEvent.change(amount, { target: { value: '12.5' } });
    fireEvent.blur(amount);
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'gt', value: 12.5 }));

    fireEvent.change(screen.getByLabelText('Operator'), { target: { value: 'between' } });
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'between', value: [12.5, undefined] }));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '30' } });
    fireEvent.blur(screen.getByLabelText('To'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: [12.5, 30] }));
    expect(screen.getByLabelText('From')).toBeInTheDocument();
  });

  it('turns the range fields into positive-only inputs for an unsigned amount', () => {
    render(<Card initial={leaf({ field: 'absAmount', op: 'between', value: [undefined, undefined] })} />);
    const from = screen.getByLabelText('From');
    fireEvent.change(from, { target: { value: '-5' } });
    fireEvent.blur(from);
    expect((from as HTMLInputElement).value).not.toContain('-');
  });

  it('uses a select of translated labels for the transaction type', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'type', op: 'eq', value: 'EXPENSE' })} onLeaf={onLeaf} />);
    const select = screen.getByLabelText('Value');
    expect(optionLabels(select)).toEqual(['Expense', 'Income', 'Transfer']);
    fireEvent.change(select, { target: { value: 'TRANSFER' } });
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'TRANSFER' }));

    fireEvent.change(screen.getByLabelText('Operator'), { target: { value: 'in' } });
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    fireEvent.click(screen.getByLabelText('Income'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: ['TRANSFER', 'INCOME'] }));
  });

  it('uses a select of the user currencies, keeping a stored one that is no longer active', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'currencyCode', op: 'eq', value: 'EUR' })} onLeaf={onLeaf} />);
    const select = screen.getByLabelText('Value');
    expect(optionLabels(select)).toEqual(['Choose a currency', 'CAD', 'EUR', 'USD']);
    expect(select).toHaveValue('EUR');
    fireEvent.change(select, { target: { value: 'USD' } });
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: 'USD' }));

    fireEvent.change(screen.getByLabelText('Operator'), { target: { value: 'in' } });
    fireEvent.click(screen.getByRole('button', { name: 'USD' }));
    fireEvent.click(screen.getByLabelText('CAD'));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: ['USD', 'CAD'] }));
  });

  it('uses a switch for has-splits and no value control for isEmpty', () => {
    const onLeaf = vi.fn();
    render(<Card initial={leaf({ field: 'hasSplits', op: 'eq', value: true })} onLeaf={onLeaf} />);
    expect(screen.getByText('Yes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Has splits' }));
    expect(onLeaf).toHaveBeenLastCalledWith(expect.objectContaining({ value: false }));
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('shows its errors on the card', () => {
    render(
      <RuleConditionCard leaf={leaf({})} options={testOptions} actions={[]} errors={['VALUE_REQUIRED']} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Enter or choose a value.');
  });

  it('stacks its three controls on a phone and puts them in a row from sm up', () => {
    render(<Card initial={leaf({})} />);
    const grid = screen.getByLabelText('Field').closest('.grid');
    expect(grid).toHaveClass('grid-cols-1');
    expect(grid?.className).toContain('sm:grid-cols-');
  });
});
