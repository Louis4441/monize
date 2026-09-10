import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { DonutCenterTotal } from './DonutCenterTotal';

/**
 * The aggregate that belongs in a donut's empty hole. It is an OVERLAY the
 * caller drops beside a `ResponsiveContainer` inside a `relative` box, so it
 * must position itself absolutely over the chart and let a hover pass through
 * to the slices beneath.
 */
describe('DonutCenterTotal', () => {
  it('shows the caption and the pre-formatted figure', () => {
    render(<DonutCenterTotal label="Total" value="$1,234.00" />);
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('$1,234.00')).toBeInTheDocument();
  });

  it('overlays the chart and does not intercept the slice hover', () => {
    const { container } = render(<DonutCenterTotal label="Total" value="$0" />);
    const overlay = container.firstElementChild as HTMLElement;
    // Centred over the whole chart box.
    expect(overlay.className).toContain('absolute');
    expect(overlay.className).toContain('inset-0');
    expect(overlay.className).toContain('justify-center');
    // Pointer events pass through the hole to the slices; only the figure
    // itself re-enables them so a PartialTotal marker inside `value` is still
    // hoverable.
    expect(overlay.className).toContain('pointer-events-none');
    const figure = screen.getByText('$0');
    expect(figure.className).toContain('pointer-events-auto');
  });

  it('renders a node value (e.g. a PartialTotal wrapper), not only a string', () => {
    render(
      <DonutCenterTotal
        label="Total"
        value={<span data-testid="wrapped">$5.00</span>}
      />,
    );
    expect(screen.getByTestId('wrapped')).toBeInTheDocument();
  });
});
