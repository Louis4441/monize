import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { GemBacktestPanel } from './GemBacktestPanel';
import { gemReport } from '@/test/gem-fixtures';

const backtest = gemReport().backtest!;

describe('GemBacktestPanel', () => {
  it('summarizes the simulated period net of costs', () => {
    render(<GemBacktestPanel backtest={backtest} />);

    expect(screen.getByText(/Simulated period:/)).toBeInTheDocument();
    expect(screen.getByText('+11.40%')).toBeInTheDocument();
    expect(screen.getByText('-22.60%')).toBeInTheDocument();
    expect(screen.getByText('68.2%')).toBeInTheDocument();
    expect(screen.getByText(/net of estimated taxes and commissions/)).toBeInTheDocument();
  });

  it('says when figures exclude costs and metrics are unknown', () => {
    render(
      <GemBacktestPanel
        backtest={{ ...backtest, netOfCosts: false, hitRatePercent: null, cagrPercent: null }}
      />,
    );
    expect(screen.getByText('Figures exclude taxes and commissions.')).toBeInTheDocument();
    expect(screen.getAllByText('Not available').length).toBe(2);
  });

  it('explains a missing backtest instead of showing zeroes', () => {
    render(<GemBacktestPanel backtest={null} />);
    expect(screen.getByText('No backtest available')).toBeInTheDocument();
    expect(screen.queryByText('Annualized return')).not.toBeInTheDocument();
  });
});
