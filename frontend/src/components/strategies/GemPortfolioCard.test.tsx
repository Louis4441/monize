import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { GemPortfolioCard } from './GemPortfolioCard';
import { gemPosition } from '@/test/gem-fixtures';

describe('GemPortfolioCard', () => {
  it('wraps a long fund name instead of cutting it off', () => {
    // "iShares MSCI ACWI UCITS ETF USD Acc (IUSQ)" does not fit a card at any
    // sensible width, and truncating hides the share class that tells two
    // otherwise identical funds apart.
    render(
      <GemPortfolioCard
        position={gemPosition({
          current: {
            role: null,
            securityId: 'sec-iusq',
            symbol: 'IUSQ',
            name: 'iShares MSCI ACWI UCITS ETF USD Acc',
            quantity: 12,
            marketValue: 1000,
            matchPercent: 0,
            matchedByInstrument: true,
            isCash: false,
            matchedMarkets: [],
          },
        })}
        noAccount={false}
      />,
    );

    const value = screen.getByText(/iShares MSCI ACWI UCITS ETF USD Acc/);
    expect(value.className).not.toContain('truncate');
    expect(value.closest('dd')?.className).toContain('break-words');
  });

  it('compares the held instrument with the target and flags the change', () => {
    render(<GemPortfolioCard position={gemPosition()} noAccount={false} />);

    // The largest holding names the position; "+2" says there are more.
    expect(screen.getByText(/SPDR S&P 500 ETF \(SPY\)/)).toBeInTheDocument();
    expect(screen.getByText('iShares MSCI EM IMI ETF (EMIM)')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Match with signal' })).toHaveAttribute(
      'aria-valuenow',
      '64',
    );
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('reads as compliant when no change is required', () => {
    render(
      <GemPortfolioCard
        position={gemPosition({ compliancePercent: 100, changeRequired: false })}
        noAccount={false}
      />,
    );
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('omits the progress value when compliance is unknown', () => {
    render(
      <GemPortfolioCard position={gemPosition({ compliancePercent: null })} noAccount={false} />,
    );
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(screen.getAllByText('Not available').length).toBeGreaterThan(0);
  });

  it('marks a missing position rather than showing a zero holding', () => {
    render(<GemPortfolioCard position={gemPosition({ current: null })} noAccount={false} />);
    expect(screen.getByText('No position')).toBeInTheDocument();
  });

  it('asks for an account when the strategy has none', () => {
    render(<GemPortfolioCard position={null} noAccount />);
    expect(screen.getByText('No account assigned')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
