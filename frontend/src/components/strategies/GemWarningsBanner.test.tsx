import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { GemWarningsBanner } from './GemWarningsBanner';

describe('GemWarningsBanner', () => {
  it('renders nothing without warnings', () => {
    const { container } = render(<GemWarningsBanner warnings={[]} lookbackMonths={12} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('raises a calculation failure as an alert', () => {
    render(<GemWarningsBanner warnings={[{ code: 'CALCULATION_FAILED' }]} lookbackMonths={12} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The signal could not be calculated from the available data.',
    );
  });

  it('names the roles missing an instrument and shows server detail', () => {
    render(
      <GemWarningsBanner
        warnings={[
          { code: 'UNMAPPED_ROLE', roles: ['SAFE', 'EM_EQUITY'] },
          { code: 'STALE_PRICES', detail: 'Last price: 2025-07-02' },
        ]}
        lookbackMonths={12}
      />,
    );
    expect(screen.getByText(/Emerging markets, Safe asset/)).toBeInTheDocument();
    expect(screen.getByText('Last price: 2025-07-02')).toBeInTheDocument();
  });

  it('leaves the in-place empty states to explain account and position gaps', () => {
    const { container } = render(
      <GemWarningsBanner warnings={[{ code: 'NO_ACCOUNT' }, { code: 'NO_POSITION' }]} lookbackMonths={12} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('treats a first run as information rather than a problem', () => {
    render(<GemWarningsBanner warnings={[{ code: 'FIRST_RUN' }]} lookbackMonths={12} />);
    expect(screen.getByRole('status')).toHaveTextContent(/has not been evaluated yet/);
  });
});
