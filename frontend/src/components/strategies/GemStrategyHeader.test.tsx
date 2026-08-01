import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { GemStrategyHeader } from './GemStrategyHeader';

describe('GemStrategyHeader', () => {
  const baseProps = {
    strategyId: 'strategy-1',
    strategyName: 'GEM Strategy',
    scenarios: [{ id: 'strategy-1', name: 'GEM Strategy' }],
    onSelectScenario: vi.fn(),
    onCreateScenario: vi.fn().mockResolvedValue(undefined),
    onDeleteScenario: vi.fn().mockResolvedValue(undefined),
    scenarioBusy: false,
    cadence: 'MONTHLY' as const,
    nextEvaluationOn: '2025-08-31',
    daysUntilNextEvaluation: 28,
  };

  it('shows the breadcrumb, title, cadence and days remaining', () => {
    render(<GemStrategyHeader {...baseProps} onEditSettings={vi.fn()} />);

    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/reports');
    expect(screen.getByRole('heading', { level: 1, name: /GEM Strategy/ })).toBeInTheDocument();
    expect(
      screen.getByText('Global equities momentum – equities versus a safe asset'),
    ).toBeInTheDocument();
    expect(screen.getByText('Evaluation frequency: monthly')).toBeInTheDocument();
    expect(screen.getByText(/in 28 days/)).toBeInTheDocument();
  });

  it('omits the day count when it is unknown', () => {
    render(
      <GemStrategyHeader {...baseProps} daysUntilNextEvaluation={null} onEditSettings={vi.fn()} />,
    );
    expect(screen.getByText(/Next evaluation:/)).toBeInTheDocument();
    expect(screen.queryByText(/in 28 days/)).not.toBeInTheDocument();
  });

  it('says the evaluation is unscheduled without a date', () => {
    render(
      <GemStrategyHeader {...baseProps} nextEvaluationOn={null} onEditSettings={vi.fn()} />,
    );
    expect(screen.getByText('Next evaluation not scheduled')).toBeInTheDocument();
  });

  it('reports the settings request', () => {
    const onEditSettings = vi.fn();
    render(<GemStrategyHeader {...baseProps} onEditSettings={onEditSettings} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit settings/ }));
    expect(onEditSettings).toHaveBeenCalledOnce();
  });
});
