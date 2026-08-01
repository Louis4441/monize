import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { GemTransferCard } from './GemTransferCard';
import { gemAction } from '@/test/gem-fixtures';

describe('GemTransferCard', () => {
  it('leads with the value to move and lists the estimated costs', () => {
    render(<GemTransferCard action={gemAction()} />);

    expect(screen.getByText('Estimated value to transfer')).toBeInTheDocument();
    expect(screen.getByText('$23,076.26')).toBeInTheDocument();
    expect(screen.getByText('+$4,794.90')).toBeInTheDocument();
    expect(screen.getByText('Estimated tax (19%)')).toBeInTheDocument();
    // The switch sells one holding and buys the target: two commissions.
    expect(screen.getByText('Estimated commission (2 trades)')).toBeInTheDocument();
    expect(screen.getByText('Broker IRA')).toBeInTheDocument();
  });

  it('signs a realized loss', () => {
    render(<GemTransferCard action={gemAction({ realizedGainLoss: -120.5 })} />);
    expect(screen.getByText('-$120.50')).toBeInTheDocument();
  });

  it('drops cost rows the server could not estimate', () => {
    render(
      <GemTransferCard
        action={gemAction({ estimatedTax: null, estimatedCommission: null, taxRatePercent: null })}
      />,
    );
    expect(screen.queryByText(/Estimated tax/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimated commission/)).not.toBeInTheDocument();
  });

  it('labels the tax without a rate when the rate is unknown', () => {
    render(<GemTransferCard action={gemAction({ taxRatePercent: null })} />);
    expect(screen.getByText('Estimated tax')).toBeInTheDocument();
  });

  it('marks an unknown transfer value instead of zero', () => {
    render(<GemTransferCard action={gemAction({ transferValue: null })} />);
    expect(screen.getByText('Transfer value not available')).toBeInTheDocument();
  });

  it('shows nothing to transfer when the portfolio already matches', () => {
    render(<GemTransferCard action={gemAction({ required: false })} />);
    expect(screen.getByText('Nothing to transfer')).toBeInTheDocument();
  });

  it('shows nothing to transfer when there is no pending action at all', () => {
    render(<GemTransferCard action={null} />);
    expect(screen.getByText('Nothing to transfer')).toBeInTheDocument();
    expect(screen.getByText(/already hold the target instrument/)).toBeInTheDocument();
  });

  it('explains the empty state differently before the first signal', () => {
    render(<GemTransferCard action={null} signalUnavailable />);
    expect(
      screen.getByText('Nothing moves until the strategy produces its first signal.'),
    ).toBeInTheDocument();
  });
});
