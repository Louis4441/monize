import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { SubcategoryBreakdownPanel } from './SubcategoryBreakdownPanel';
import type { SubcategoryShare } from '@/lib/categoryUtils';

const shares: SubcategoryShare[] = [
  { id: 'child-1', name: 'Coffee', total: -1200, count: 5, share: 0.8 },
  // The self bucket: rows filed on the category itself, name nulled upstream.
  { id: 'cat-1', name: null, total: -300, count: 2, share: 0.2 },
];

function renderPanel(
  overrides: {
    shares?: SubcategoryShare[];
    isLoading?: boolean;
  } = {},
) {
  const onSelectChild = vi.fn();
  render(
    <SubcategoryBreakdownPanel
      shares={overrides.shares ?? shares}
      currencyCode="CAD"
      isLoading={overrides.isLoading ?? false}
      onSelectChild={onSelectChild}
    />,
  );
  return { onSelectChild };
}

describe('SubcategoryBreakdownPanel', () => {
  it('titles the panel and lists each bucket', () => {
    renderPanel();
    expect(screen.getByText('Subcategories')).toBeInTheDocument();
    expect(
      screen.getByText('All time, each including its own subcategories'),
    ).toBeInTheDocument();
    expect(screen.getByText('Coffee')).toBeInTheDocument();
  });

  it('labels the self bucket "This category" and leaves it unselectable', () => {
    const { onSelectChild } = renderPanel();
    const selfRow = screen.getByText('This category');
    expect(selfRow).toBeInTheDocument();
    // Clicking the reader's own category would navigate to the page they are on.
    expect(selfRow.closest('button')).toBeNull();
    fireEvent.click(selfRow);
    expect(onSelectChild).not.toHaveBeenCalled();
  });

  it('opens a child category from its row', () => {
    const { onSelectChild } = renderPanel();
    fireEvent.click(screen.getByText('Coffee'));
    expect(onSelectChild).toHaveBeenCalledWith('child-1');
  });

  it('shows the empty label when there are no buckets', () => {
    renderPanel({ shares: [] });
    expect(screen.getByText('This category has no subcategories')).toBeInTheDocument();
  });
});
