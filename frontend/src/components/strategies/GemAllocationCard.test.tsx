import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { GemAllocationCard } from './GemAllocationCard';
import { gemSignal } from '@/test/gem-fixtures';

describe('GemAllocationCard', () => {
  it('shows the target weight and the three rules behind it', () => {
    render(
      <GemAllocationCard signal={gemSignal()} winnerRole="EM_EQUITY" cadence="MONTHLY" />,
    );

    expect(
      screen.getByRole('img', { name: 'Target allocation: 100% EMIM' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Evaluated monthly')).toBeInTheDocument();
    expect(
      screen.getByText('Two decisions: absolute then relative momentum'),
    ).toBeInTheDocument();
    expect(screen.getByText('Always 100% in a single asset')).toBeInTheDocument();
  });

  it('handles a signal whose winner role is unknown', () => {
    render(<GemAllocationCard signal={gemSignal()} winnerRole={null} cadence="QUARTERLY" />);
    expect(screen.getByText('Evaluated quarterly')).toBeInTheDocument();
  });

  it('renders an empty state before the first signal', () => {
    render(<GemAllocationCard signal={null} winnerRole={null} cadence="MONTHLY" />);
    expect(screen.getByText('No target allocation')).toBeInTheDocument();
  });
});
