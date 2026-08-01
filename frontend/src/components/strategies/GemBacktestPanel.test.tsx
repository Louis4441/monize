import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { GemBacktestPanel } from './GemBacktestPanel';
import { gemReport } from '@/test/gem-fixtures';

const backtest = gemReport().backtest!;

describe('GemBacktestPanel', () => {
  it('says when the run covers only the recent part of the history', () => {
    // Below 100% the simulation is the most recent unbroken stretch of priced
    // periods -- everything before the last gap is left out of it, not held
    // flat -- so the window the figures describe is shorter than the strategy
    // has been running. Saying nothing makes them look like the whole record.
    render(<GemBacktestPanel backtest={{ ...backtest, coveragePercent: 60 }} />);
    expect(
      screen.getByText(/Prices cover only the most recent 60% of the evaluated periods/),
    ).toBeInTheDocument();
    expect(screen.getByText(/left out of the figures above/)).toBeInTheDocument();
  });

  it('says nothing about coverage when every period was priced', () => {
    render(<GemBacktestPanel backtest={backtest} />);
    expect(screen.queryByText(/Prices cover only/)).not.toBeInTheDocument();
  });

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
        backtest={{
          ...backtest,
          taxApplied: false,
          commissionApplied: false,
          hitRatePercent: null,
          cagrPercent: null,
        }}
      />,
    );
    expect(screen.getByText('Figures exclude taxes and commissions.')).toBeInTheDocument();
    expect(screen.getAllByText('Not available').length).toBe(2);
  });

  it('names the cost that was actually deducted when only one could be', () => {
    // A configured commission needs a known portfolio total to become a drag,
    // and the total is unknown whenever a holding cannot be priced. Under one
    // net-of-costs flag this printed "net of estimated taxes and commissions"
    // over figures no commission had come off.
    render(
      <GemBacktestPanel backtest={{ ...backtest, taxApplied: true, commissionApplied: false }} />,
    );
    expect(
      screen.getByText('Figures are net of estimated taxes, but not of commissions.'),
    ).toBeInTheDocument();

    render(
      <GemBacktestPanel backtest={{ ...backtest, taxApplied: false, commissionApplied: true }} />,
    );
    expect(
      screen.getByText('Figures are net of estimated commissions, but not of taxes.'),
    ).toBeInTheDocument();
  });

  it('explains a missing backtest instead of showing zeroes', () => {
    render(<GemBacktestPanel backtest={null} />);
    expect(screen.getByText('No backtest available')).toBeInTheDocument();
    expect(screen.queryByText('Annualized return')).not.toBeInTheDocument();
  });
});
