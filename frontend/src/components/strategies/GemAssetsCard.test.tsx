import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { GemAssetsCard } from './GemAssetsCard';
import { gemAssets } from '@/test/gem-fixtures';

describe('GemAssetsCard', () => {
  it('counts the roles and lists each instrument, marking the winner', () => {
    render(<GemAssetsCard assets={gemAssets} winnerRole="EM_EQUITY" />);

    expect(screen.getByRole('img', { name: 'Strategy uses 5 assets' })).toBeInTheDocument();
    expect(screen.getByText('S&P 500')).toBeInTheDocument();
    expect(screen.getByText('(SPY)')).toBeInTheDocument();
    expect(screen.getByText('winner')).toBeInTheDocument();
  });

  it('calls out a role with no instrument assigned', () => {
    render(
      <GemAssetsCard
        assets={[
          ...gemAssets.slice(0, 3),
          { role: 'SAFE', securityId: null, symbol: null, name: null },
        ]}
        winnerRole={null}
      />,
    );
    expect(screen.getByText('(no instrument)')).toBeInTheDocument();
    expect(screen.queryByText('winner')).not.toBeInTheDocument();
  });

  it('falls back to the canonical roles when the server sent none', () => {
    render(<GemAssetsCard assets={[]} winnerRole={null} />);
    expect(screen.getByRole('img', { name: 'Strategy uses 5 assets' })).toBeInTheDocument();
    expect(screen.getAllByText('(no instrument)')).toHaveLength(5);
  });
});
