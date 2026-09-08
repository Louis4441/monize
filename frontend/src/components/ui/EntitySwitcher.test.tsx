import { describe, it, expect, vi } from 'vitest';
import { act, screen, fireEvent, within } from '@testing-library/react';
import { render } from '@/test/render';
import {
  EntitySwitcher,
  MENU_WIDTH,
  VIEWPORT_MARGIN,
  placeMenu,
  type EntitySwitcherItem,
} from './EntitySwitcher';

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

  describe('placement', () => {
    /**
     * The caret sits at the end of a long account name in the Transactions
     * page's Account Info widget, and on a phone that is near the right edge.
     * An absolute `left-0 w-72` menu from there ran off the screen.
     */
    const caretNearRightEdge = { left: 300, top: 16, bottom: 40 };

    it('slides the menu left so it stays inside a narrow viewport', () => {
      const placed = placeMenu(caretNearRightEdge, 360, 800);
      expect(placed.width).toBe(MENU_WIDTH);
      expect(placed.left + placed.width).toBeLessThanOrEqual(360 - VIEWPORT_MARGIN);
      expect(placed.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
      expect(placed.top).toBe(caretNearRightEdge.bottom + 4);
    });

    it('opens at the caret when there is room to its right', () => {
      const placed = placeMenu({ left: 40, top: 16, bottom: 40 }, 1280, 800);
      expect(placed.left).toBe(40);
      expect(placed.width).toBe(MENU_WIDTH);
    });

    it('shrinks the menu on a viewport narrower than the menu itself', () => {
      const placed = placeMenu(caretNearRightEdge, 240, 800);
      expect(placed.width).toBe(240 - 2 * VIEWPORT_MARGIN);
      expect(placed.left).toBe(VIEWPORT_MARGIN);
    });

    it('opens upward when the caret is near the bottom and the room is above', () => {
      const placed = placeMenu({ left: 40, top: 700, bottom: 724 }, 1280, 800);
      expect(placed.bottom).toBe(800 - 700 + 4);
      expect(placed.top).toBeUndefined();
      expect(placed.maxHeight).toBeLessThanOrEqual(700);
    });

    it('renders the menu in a portal, so a clipping or transformed ancestor cannot cut it off', () => {
      open(two);
      const menu = screen.getByRole('menu');
      expect(menu.parentElement).toBe(document.body);
      expect(menu.style.position).toBe('fixed');
    });

    it('positions the rendered menu from the caret, clamped to the viewport', () => {
      const originalWidth = window.innerWidth;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
      const rectSpy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({
          left: 300,
          right: 324,
          top: 16,
          bottom: 40,
          width: 24,
          height: 24,
          x: 300,
          y: 16,
          toJSON: () => ({}),
        } as DOMRect);
      try {
        open(two);
        const menu = screen.getByRole('menu');
        const left = parseFloat(menu.style.left);
        const width = parseFloat(menu.style.width);
        expect(left + width).toBeLessThanOrEqual(360 - VIEWPORT_MARGIN);
        expect(left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
      } finally {
        rectSpy.mockRestore();
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
      }
    });

    it('treats a click inside the portalled menu as inside, and one elsewhere as outside', () => {
      open(many(12));
      fireEvent.mouseDown(screen.getByPlaceholderText(LABELS.filterPlaceholder));
      expect(screen.getByRole('menu')).toBeInTheDocument();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('closes when the page scrolls, but not when its own list does', async () => {
      open(many(12));
      const list = screen.getByRole('menu').querySelector('.overflow-y-auto') as HTMLElement;
      // The listener is a capturing one on window, so a non-bubbling scroll on
      // the list still reaches it and is told apart by its target.
      await act(async () => {
        list.dispatchEvent(new Event('scroll', { bubbles: false }));
      });
      expect(screen.getByRole('menu')).toBeInTheDocument();
      await act(async () => {
        document.documentElement.dispatchEvent(new Event('scroll', { bubbles: false }));
      });
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('closes when the window resizes', async () => {
      open(two);
      await act(async () => {
        window.dispatchEvent(new Event('resize'));
      });
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });
});
