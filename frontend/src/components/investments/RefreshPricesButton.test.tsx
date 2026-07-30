import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@/test/render';
import { fireEvent, screen } from '@testing-library/react';
import { RefreshPricesButton } from './RefreshPricesButton';

describe('RefreshPricesButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onClick when pressed', () => {
    const onClick = vi.fn();
    render(<RefreshPricesButton onClick={onClick} isRefreshing={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('disables itself and says it is updating while a refresh is in flight', () => {
    const onClick = vi.fn();
    render(<RefreshPricesButton onClick={onClick} isRefreshing />);
    const button = screen.getByRole('button', { name: 'Refresh' });
    expect(button).toBeDisabled();
    expect(screen.getByText('Updating...')).toBeInTheDocument();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows the age of the last refresh inline and in the tooltip', () => {
    render(
      <RefreshPricesButton
        onClick={vi.fn()}
        isRefreshing={false}
        lastPriceUpdate="2026-07-30T10:00:00.000Z"
      />,
    );
    expect(screen.getByText('(2h ago)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute(
      'title',
      'Last updated: 2h ago',
    );
  });

  it('says so when the caller tracks the last refresh and there has been none', () => {
    render(
      <RefreshPricesButton
        onClick={vi.fn()}
        isRefreshing={false}
        lastPriceUpdate={null}
      />,
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute(
      'title',
      'Never updated',
    );
  });

  it('falls back to the plain label when no last-refresh time is tracked', () => {
    render(<RefreshPricesButton onClick={vi.fn()} isRefreshing={false} />);
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute(
      'title',
      'Refresh',
    );
  });
});
