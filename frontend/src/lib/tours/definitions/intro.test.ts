import { describe, it, expect } from 'vitest';
import { INTRO_TOUR } from './intro';
import { TOUR_ANCHORS } from '../anchors';

const step = (id: string) => INTRO_TOUR.steps.find((s) => s.id === id)!;

describe('introduction tour', () => {
  // Dimming a screen the step is introducing hides the thing being described.
  const PAGE_STEPS = [
    'accounts',
    'transactions',
    'bills',
    'investments',
    'budgets',
    'reports',
  ];

  it.each(PAGE_STEPS)('leaves the page visible on the "%s" step', (id) => {
    expect(step(id).unobtrusive).toBe(true);
  });

  it('still rings the button on the undimmed anchored steps', () => {
    // Undimmed but anchored: the ring is what keeps the step pointing at the
    // control its copy names.
    expect(step('accounts').anchorId).toBe(TOUR_ANCHORS.accountsAddButton);
    expect(step('transactions').anchorId).toBe(TOUR_ANCHORS.transactionsNewButton);
  });

  it('keeps the in-form and menu steps dimmed', () => {
    // These point at one control on a busy screen, where the dim is the point.
    for (const id of ['dashboard', 'tools', 'fields', 'splits', 'currencyField']) {
      expect(step(id).unobtrusive).toBeUndefined();
    }
  });

  it('highlights the form buttons on the close-the-form step', () => {
    const close = step('closeForm');
    expect(close.anchorId).toBe(TOUR_ANCHORS.transactionFormActions);
    expect(close.placement).toBe('top');
    // Still driven by the form going away, however the user closes it.
    expect(close.advance).toEqual({
      type: 'disappear',
      anchorId: TOUR_ANCHORS.transactionForm,
    });
  });
});
