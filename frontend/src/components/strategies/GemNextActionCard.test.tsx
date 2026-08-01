import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { GemNextActionCard } from './GemNextActionCard';
import { gemAction } from '@/test/gem-fixtures';

const handlers = () => ({
  onMarkExecuted: vi.fn(),
  onAddTransactions: vi.fn(),
});

describe('GemNextActionCard', () => {
  it('spells out the switch, the estimates and both actions', () => {
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction()}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );

    expect(screen.getByText('The strategy signal changed')).toBeInTheDocument();
    expect(screen.getByText('SPDR S&P 500 ETF (SPY)')).toBeInTheDocument();
    expect(screen.getByText('51 units')).toBeInTheDocument();
    expect(screen.getByText('changes to')).toBeInTheDocument();
    expect(screen.getByText('iShares MSCI EM IMI ETF (EMIM)')).toBeInTheDocument();
    expect(screen.getByText('100% of the strategy accounts')).toBeInTheDocument();
    expect(screen.getByText('$23,076.26')).toBeInTheDocument();
    expect(screen.getByText('+$4,794.90')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Mark as executed/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add transactions/ }));
    expect(onMarkExecuted).toHaveBeenCalledOnce();
    expect(onAddTransactions).toHaveBeenCalledOnce();
  });

  it('shows the positive state with no buttons when nothing is required', () => {
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction({ required: false })}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );
    expect(screen.getByText('Your portfolio matches the strategy')).toBeInTheDocument();
    expect(screen.getByText(/nothing to do right now/)).toBeInTheDocument();
    // The card's own actions, not every button on it: the help trigger is one
    // too, and has to be, or screen readers announce a nameless tab stop.
    expect(
      screen.queryByRole('button', { name: /Mark as executed|Add transactions/ }),
    ).not.toBeInTheDocument();
  });

  it('says so when the accounts still do not match a signal marked as done', () => {
    // "Executed" is recorded against the signal; what has to be done is
    // recomputed from the accounts. Deposit cash after a completed switch and
    // both are true at once -- the card used to show only the tick, hiding a
    // live instruction behind it.
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction({ executed: true })}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );
    expect(
      screen.getByText(/You marked this as done, but these accounts still do not match/),
    ).toBeInTheDocument();
    // Marking it again would do nothing; recording the trades is the way out.
    expect(screen.queryByRole('button', { name: /Mark as executed/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add transactions/ })).toBeInTheDocument();
  });

  it('says nothing about a mismatch once the accounts match again', () => {
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction({ executed: true, required: false })}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );
    expect(screen.getByText('Your portfolio matches the strategy')).toBeInTheDocument();
    expect(screen.queryByText(/still do not match/)).not.toBeInTheDocument();
  });

  it('says how many other instruments the switch sells out of', () => {
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction({ fromCount: 3 })}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );
    expect(screen.getByText('and 2 more instruments')).toBeInTheDocument();
  });

  it('names a single holding without a count', () => {
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction({ fromCount: 1 })}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );
    expect(screen.queryByText(/more instrument/)).toBeNull();
  });

  it('marks unknown units and a missing position without zeroes', () => {
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction({ from: null, transferValue: null, realizedGainLoss: null })}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );
    expect(screen.getByText('No position held')).toBeInTheDocument();
    expect(screen.getAllByText('Not available').length).toBeGreaterThan(1);
  });

  it('says there is nothing to act on when no signal exists', () => {
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={null}
        signalUnavailable
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );
    expect(screen.getByText('There is no signal to act on yet.')).toBeInTheDocument();
  });

  it('disables the primary action while saving', () => {
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction()}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving
      />,
    );
    expect(screen.getByRole('button', { name: /Mark as executed/ })).toBeDisabled();
  });
});
