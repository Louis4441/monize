import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityWeightingsCard } from './SecurityWeightingsCard';

const EMPTY = 'No breakdown stored';

function renderCard(
  slices: { name: string; weight: number }[] | null | undefined,
  remainderLabel?: (percent: string) => string,
) {
  return render(
    <SecurityWeightingsCard
      title="Sector breakdown"
      slices={slices}
      emptyMessage={EMPTY}
      remainderLabel={remainderLabel}
    />,
  );
}

/** The fill element of each row, in DOM order. */
function bars(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll('li > div[role="img"] > div'),
  ) as HTMLElement[];
}

describe('SecurityWeightingsCard', () => {
  it('lists each share with its percentage', () => {
    renderCard([
      { name: 'Technology', weight: 0.324 },
      { name: 'Financials', weight: 0.181 },
    ]);

    expect(screen.getByText('Technology')).toBeInTheDocument();
    expect(screen.getByText('32.40%')).toBeInTheDocument();
    expect(screen.getByText('Financials')).toBeInTheDocument();
    expect(screen.getByText('18.10%')).toBeInTheDocument();
  });

  it('orders the shares largest first', () => {
    renderCard([
      { name: 'Small', weight: 0.1 },
      { name: 'Biggest', weight: 0.6 },
      { name: 'Middle', weight: 0.3 },
    ]);

    const names = screen
      .getAllByRole('listitem')
      .map((row) => row.textContent?.split(/\d/)[0]);
    expect(names).toEqual(['Biggest', 'Middle', 'Small']);
  });

  it('labels every bar for assistive tech, so colour is never the only signal', () => {
    renderCard([{ name: 'Technology', weight: 0.324 }]);
    expect(
      screen.getByRole('img', { name: 'Technology: 32.40%' }),
    ).toBeInTheDocument();
  });

  it('scales the bars against the largest share, not against 100%', () => {
    const { container } = renderCard([
      { name: 'Biggest', weight: 0.22 },
      { name: 'Half of it', weight: 0.11 },
    ]);

    const [first, second] = bars(container);
    // A fund whose top sector is 22% would otherwise draw every bar as a sliver.
    expect(first.style.width).toBe('100%');
    expect(second.style.width).toBe('50%');
  });

  it('keeps a tiny share visible rather than drawing nothing', () => {
    const { container } = renderCard([
      { name: 'Huge', weight: 0.9 },
      { name: 'Sliver', weight: 0.0001 },
    ]);
    expect(bars(container)[1].style.width).toBe('2%');
  });

  describe('missing data', () => {
    it('says so rather than drawing empty bars', () => {
      const { container } = renderCard(null);
      expect(screen.getByText(EMPTY)).toBeInTheDocument();
      // A security with no sector data is not one with zero-length bars.
      expect(bars(container)).toHaveLength(0);
    });

    it('treats an empty list the same as no list', () => {
      renderCard([]);
      expect(screen.getByText(EMPTY)).toBeInTheDocument();
    });

    it('drops unusable rows instead of plotting them', () => {
      const { container } = renderCard([
        { name: 'Real', weight: 0.5 },
        { name: 'Zero', weight: 0 },
        { name: '', weight: 0.2 },
        { name: 'NaN', weight: Number.NaN },
      ]);
      expect(bars(container)).toHaveLength(1);
      expect(screen.getByText('Real')).toBeInTheDocument();
    });

    it('falls back to the empty state when every row is unusable', () => {
      renderCard([{ name: 'Zero', weight: 0 }]);
      expect(screen.getByText(EMPTY)).toBeInTheDocument();
    });
  });

  describe('unclassified remainder', () => {
    it('names the gap when the shares do not reach 100%', () => {
      renderCard(
        [
          { name: 'Technology', weight: 0.6 },
          { name: 'Financials', weight: 0.25 },
        ],
        (percent) => `${percent} unclassified`,
      );
      // Providers report the classified part only; saying so beats letting the
      // reader assume the rest is missing.
      expect(screen.getByText('15.00% unclassified')).toBeInTheDocument();
    });

    it('stays quiet when the shares add up', () => {
      renderCard(
        [
          { name: 'Technology', weight: 0.6 },
          { name: 'Financials', weight: 0.4 },
        ],
        (percent) => `${percent} unclassified`,
      );
      expect(screen.queryByText(/unclassified/)).toBeNull();
    });

    it('ignores a rounding-sized gap', () => {
      renderCard(
        [{ name: 'Technology', weight: 0.998 }],
        (percent) => `${percent} unclassified`,
      );
      expect(screen.queryByText(/unclassified/)).toBeNull();
    });

    it('says nothing about a remainder when not asked to', () => {
      renderCard([{ name: 'Technology', weight: 0.5 }]);
      expect(screen.queryByText(/unclassified/)).toBeNull();
    });
  });
});
