import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { CategoryTagBreakdownPanel } from './CategoryTagBreakdownPanel';

// The chart has its own tests (and its own fetch); stub it so this one asserts
// what key and params the panel hands down.
const chartProps = vi.fn();
vi.mock('@/components/transactions/TagKeyBreakdownChart', () => ({
  TagKeyBreakdownChart: (props: { tagKey: string; params: unknown }) => {
    chartProps(props);
    return (
      <div
        data-testid="tag-chart"
        data-key={props.tagKey}
        data-params={JSON.stringify(props.params)}
      />
    );
  },
}));

function renderPanel(tagKeys: string[], refreshKey?: number) {
  return render(
    <CategoryTagBreakdownPanel
      categoryId="cat-1"
      tagKeys={tagKeys}
      refreshKey={refreshKey}
    />,
  );
}

describe('CategoryTagBreakdownPanel', () => {
  beforeEach(() => {
    chartProps.mockClear();
  });

  it('renders nothing at all when the user has no tag keys', () => {
    const { container } = renderPanel([]);
    expect(container.firstChild).toBeNull();
    expect(chartProps).not.toHaveBeenCalled();
  });

  it('charts the only key without offering a picker', () => {
    renderPanel(['country']);
    expect(screen.queryByRole('combobox')).toBeNull();
    const chart = screen.getByTestId('tag-chart');
    expect(chart.getAttribute('data-key')).toBe('country');
    expect(chart.getAttribute('data-params')).toBe(
      JSON.stringify({ categoryIds: ['cat-1'] }),
    );
  });

  it('offers a picker for several keys and swaps the chart on change', () => {
    renderPanel(['country', 'project']);
    expect(screen.getByText('Tag Breakdown')).toBeInTheDocument();
    expect(screen.getByTestId('tag-chart').getAttribute('data-key')).toBe('country');

    const select = screen.getByRole('combobox', { name: 'Tag key' });
    fireEvent.change(select, { target: { value: 'project' } });

    const chart = screen.getByTestId('tag-chart');
    expect(chart.getAttribute('data-key')).toBe('project');
    expect(chart.getAttribute('data-params')).toBe(
      JSON.stringify({ categoryIds: ['cat-1'] }),
    );
  });
});
