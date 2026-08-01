import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { GemSignalCard } from './GemSignalCard';
import { gemAssets, gemSignal } from '@/test/gem-fixtures';

const baseProps = {
  nextEvaluationOn: '2025-08-31',
  daysUntilNextEvaluation: 28,
  firstRun: false,
  failed: false,
};

describe('GemSignalCard', () => {
  it('states the RISK-ON allocation with both dates and the test outcome', () => {
    render(<GemSignalCard {...baseProps} signal={gemSignal()} />);

    expect(screen.getByText('RISK-ON')).toBeInTheDocument();
    expect(screen.getByText('100% iShares MSCI EM IMI ETF')).toBeInTheDocument();
    expect(screen.getByText('iShares MSCI EM IMI ETF (EMIM)')).toBeInTheDocument();
    expect(screen.getByText('Effective from')).toBeInTheDocument();
    expect(screen.getByText(/in 28 days/)).toBeInTheDocument();
    expect(
      screen.getByText('Equities win both the absolute and the relative test.'),
    ).toBeInTheDocument();
  });

  it('explains a RISK-OFF signal as a move to the safe asset', () => {
    render(
      <GemSignalCard
        {...baseProps}
        signal={gemSignal({
          state: 'RISK_OFF',
          target: gemAssets[3],
          relative: { ...gemSignal().relative, applied: false },
        })}
      />,
    );
    expect(screen.getByText('RISK-OFF')).toBeInTheDocument();
    expect(screen.getByText('100% Treasury Bond ETF')).toBeInTheDocument();
    expect(screen.getByText(/allocation moves to the safe asset/)).toBeInTheDocument();
  });

  it('shows the next evaluation date alone when the day count is unknown', () => {
    render(<GemSignalCard {...baseProps} daysUntilNextEvaluation={null} signal={gemSignal()} />);
    expect(screen.queryByText(/in 28 days/)).not.toBeInTheDocument();
  });

  it('says the next evaluation is unscheduled when there is no date', () => {
    render(<GemSignalCard {...baseProps} nextEvaluationOn={null} signal={gemSignal()} />);
    expect(screen.getByText('Next evaluation not scheduled')).toBeInTheDocument();
  });

  it('renders the first-run state instead of an empty signal', () => {
    render(<GemSignalCard {...baseProps} firstRun signal={null} />);
    expect(screen.getByText('No signal yet')).toBeInTheDocument();
    expect(screen.getByText(/first signal appears after/)).toBeInTheDocument();
  });

  it('renders a calculation failure distinctly from a first run', () => {
    render(<GemSignalCard {...baseProps} failed signal={null} />);
    expect(screen.getByText('Signal could not be calculated')).toBeInTheDocument();
  });

  it('falls back to a generic unavailable message', () => {
    render(<GemSignalCard {...baseProps} signal={null} />);
    expect(
      screen.getByText('No current signal is available for this strategy.'),
    ).toBeInTheDocument();
  });
});
