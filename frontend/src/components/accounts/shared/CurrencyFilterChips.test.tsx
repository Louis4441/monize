import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { CurrencyFilterChips } from './CurrencyFilterChips';

describe('CurrencyFilterChips', () => {
  it('renders nothing when no currency is selected', () => {
    const { container } = render(
      <CurrencyFilterChips selected={[]} onChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a removable pill for each selected currency', () => {
    render(<CurrencyFilterChips selected={['EUR', 'USD']} onChange={vi.fn()} />);
    expect(screen.getByText('EUR')).toBeInTheDocument();
    expect(screen.getByText('USD')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /remove eur filter/i }),
    ).toBeInTheDocument();
  });

  it('removes only the clicked currency from the selection', () => {
    const onChange = vi.fn();
    render(
      <CurrencyFilterChips selected={['EUR', 'USD']} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /remove eur filter/i }));

    expect(onChange).toHaveBeenCalledWith(['USD']);
  });
});
