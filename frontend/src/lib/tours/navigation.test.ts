import { describe, it, expect, afterEach } from 'vitest';
import { backTargetIndex } from './navigation';
import { TOUR_ANCHORS } from './anchors';
import type { TourStep } from './types';

const STEPS: readonly TourStep[] = [
  { id: 'welcome', anchorId: null },
  { id: 'openForm', anchorId: TOUR_ANCHORS.transactionsNewButton },
  {
    id: 'fields',
    anchorId: TOUR_ANCHORS.transactionFields,
    skipOnBack: true,
  },
  {
    id: 'closeForm',
    anchorId: TOUR_ANCHORS.transactionFormActions,
    skipOnBack: true,
  },
  { id: 'bills', anchorId: null },
];

function mountAnchor(id: string) {
  const el = document.createElement('div');
  el.setAttribute('data-tour-id', id);
  document.body.appendChild(el);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('backTargetIndex', () => {
  it('has no target on the first step', () => {
    expect(backTargetIndex(STEPS, 0)).toBeNull();
  });

  it('steps back one when the previous step is replayable', () => {
    expect(backTargetIndex(STEPS, 1)).toBe(0);
  });

  it('walks past in-form steps once the form is gone', () => {
    // From "bills": neither in-form anchor is mounted, so Back has to land on
    // the step that opens the form again rather than inside it.
    expect(backTargetIndex(STEPS, 4)).toBe(1);
  });

  it('keeps in-form steps replayable while the form is open', () => {
    mountAnchor(TOUR_ANCHORS.transactionFields);
    expect(backTargetIndex(STEPS, 3)).toBe(2);
  });
});
