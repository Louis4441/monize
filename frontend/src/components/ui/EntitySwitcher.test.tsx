import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
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

  describe('grouped items', () => {
    /** Two sections, deliberately interleaved in the input array. */
    const grouped: EntitySwitcherItem[] = [
      { id: 'item-1', primary: 'Alpha', group: 'Spending' },
      { id: 'item-2', primary: 'Beta', group: 'Spending' },
      { id: 'item-3', primary: 'Gamma', group: 'Budget' },
    ];

    it('puts each row under its section heading', () => {
      open(grouped);
      const spending = screen.getByRole('group', { name: 'Spending' });
      const budget = screen.getByRole('group', { name: 'Budget' });
      // Alpha is the current entity, so Spending keeps only Beta.
      expect(within(spending).getByRole('menuitem', { name: /Beta/ })).toBeInTheDocument();
      expect(within(budget).getByRole('menuitem', { name: /Gamma/ })).toBeInTheDocument();
    });

    it('orders the sections by where each first appears, and reunites strays', () => {
      // Interleaved on purpose: Beta arrives after a Budget row, and still
      // belongs under the heading its section opened with.
      open(
        [
          { id: 'item-1', primary: 'Alpha', group: 'Spending' },
          { id: 'item-3', primary: 'Gamma', group: 'Budget' },
          { id: 'item-2', primary: 'Beta', group: 'Spending' },
        ],
        // Not one of them, so nothing is filtered out of the sections.
        'elsewhere',
      );
      const headings = screen
        .getAllByRole('group')
        .map((g) => g.getAttribute('aria-label'));
      expect(headings).toEqual(['Spending', 'Budget']);
      const spending = screen.getByRole('group', { name: 'Spending' });
      expect(
        within(spending)
          .getAllByRole('menuitem')
          .map((row) => row.textContent),
      ).toEqual(['Alpha', 'Beta']);
    });

    it('drops a section whose every row was filtered out', () => {
      // Long enough for the filter box; only the Budget row matches "gamma".
      open([...many(9), ...grouped], 'item-0');
      fireEvent.change(screen.getByPlaceholderText(LABELS.filterPlaceholder), {
        target: { value: 'gamma' },
      });
      expect(screen.getByRole('group', { name: 'Budget' })).toBeInTheDocument();
      // A heading with nothing under it reads as a section that lost its rows.
      expect(screen.queryByRole('group', { name: 'Spending' })).toBeNull();
    });

    it('leaves an ungrouped list free of headings', () => {
      open(two);
      expect(screen.queryAllByRole('group')).toEqual([]);
    });
  });

  it('closes on Escape and returns focus to the caret', () => {
    open(two);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: LABELS.triggerLabel })).toHaveFocus();
  });
});
