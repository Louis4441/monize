import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { EntitySwitcher, type EntitySwitcherItem } from './EntitySwitcher';

const LABELS = {
  triggerLabel: 'Switch thing',
  filterPlaceholder: 'Filter things...',
  noMatchesLabel: 'No things match',
};

function item(id: string, primary: string, secondary?: string): EntitySwitcherItem {
  return { id, primary, secondary };
}

/** More than the filter threshold of 8, so the box appears. */
function many(count: number): EntitySwitcherItem[] {
  return Array.from({ length: count }, (_, index) =>
    item(`item-${index}`, `Thing number ${index}`),
  );
}

const two = [item('item-1', 'Alpha'), item('item-2', 'Beta')];

function open(items: EntitySwitcherItem[], currentId = 'item-1') {
  const onSelect = vi.fn();
  render(
    <EntitySwitcher
      currentId={currentId}
      items={items}
      onSelect={onSelect}
      {...LABELS}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: LABELS.triggerLabel }));
  return { onSelect };
}

describe('EntitySwitcher', () => {
  it('renders nothing when there is nowhere else to go', () => {
    render(
      <EntitySwitcher
        currentId="item-1"
        items={[two[0]]}
        onSelect={vi.fn()}
        {...LABELS}
      />,
    );
    expect(screen.queryByRole('button', { name: LABELS.triggerLabel })).toBeNull();
  });

  it('lists the others, not the current one', () => {
    open(two);
    expect(screen.getByRole('menuitem', { name: /Beta/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Alpha/ })).toBeNull();
  });

  it('selects an entity and closes', () => {
    const { onSelect } = open(two);
    fireEvent.click(screen.getByRole('menuitem', { name: /Beta/ }));
    expect(onSelect).toHaveBeenCalledWith('item-2');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('hides the filter for a short list', () => {
    open(two);
    expect(screen.queryByPlaceholderText(LABELS.filterPlaceholder)).toBeNull();
  });

  it('matches searchText rather than the visible label when one is given', () => {
    const onSelect = vi.fn();
    const items = [
      ...many(9),
      { id: 'sec-1', primary: 'AAPL', secondary: 'Apple Inc.', searchText: 'AAPL Apple Inc.' },
    ];
    render(
      <EntitySwitcher currentId="item-0" items={items} onSelect={onSelect} {...LABELS} />,
    );
    fireEvent.click(screen.getByRole('button', { name: LABELS.triggerLabel }));
    fireEvent.change(screen.getByPlaceholderText(LABELS.filterPlaceholder), {
      target: { value: 'apple' },
    });
    // "apple" appears only in the secondary text, which `primary` alone would miss.
    expect(screen.getByRole('menuitem', { name: /AAPL/ })).toBeInTheDocument();
  });

  it('says when nothing matches the filter', () => {
    open(many(12), 'item-0');
    fireEvent.change(screen.getByPlaceholderText(LABELS.filterPlaceholder), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText(LABELS.noMatchesLabel)).toBeInTheDocument();
  });

  it('clears the filter when it closes, so reopening shows the whole list', () => {
    open(many(12), 'item-0');
    fireEvent.change(screen.getByPlaceholderText(LABELS.filterPlaceholder), {
      target: { value: 'number 7' },
    });
    // Close via the caret, then reopen.
    fireEvent.click(screen.getByRole('button', { name: LABELS.triggerLabel }));
    fireEvent.click(screen.getByRole('button', { name: LABELS.triggerLabel }));
    expect(screen.getByRole('menuitem', { name: /Thing number 3/ })).toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the caret', () => {
    open(two);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: LABELS.triggerLabel })).toHaveFocus();
  });
});
