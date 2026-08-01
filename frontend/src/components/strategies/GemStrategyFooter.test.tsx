import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { GemStrategyFooter } from './GemStrategyFooter';
import { gemReport } from '@/test/gem-fixtures';

describe('GemStrategyFooter', () => {
  it('refuses to link an address that is not http(s)', () => {
    // A stored `javascript:` address in an href is a click away from running;
    // the footer drops the link rather than rendering it.
    const strategy = gemReport().strategy;
    render(
      <GemStrategyFooter
        strategy={{
          ...strategy,
          rulesSourceUrl: 'javascript:alert(1)',
          rulesSourceLabel: 'Rules',
        }}
      />,
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('No rules source configured.')).toBeInTheDocument();
  });

  it('states the caveats and links the rules source', () => {
    render(<GemStrategyFooter strategy={gemReport().strategy} />);

    expect(screen.getByText('Past results do not guarantee future returns.')).toBeInTheDocument();
    expect(screen.getByText(/requires consistency/)).toBeInTheDocument();
    expect(screen.getByText('Account for taxes, commissions and spreads.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'example.test/gem' })).toHaveAttribute(
      'href',
      'https://example.test/gem',
    );
    expect(screen.getByText(/Data last updated:/)).toBeInTheDocument();
  });

  it('falls back to the hostname when no label is configured', () => {
    const strategy = gemReport().strategy;
    render(
      <GemStrategyFooter strategy={{ ...strategy, rulesSourceLabel: null }} />,
    );
    expect(
      screen.getByRole('link', { name: 'example.test' }),
    ).toBeInTheDocument();
  });

  it('says so when the source and the price date are unknown', () => {
    const strategy = gemReport().strategy;
    render(
      <GemStrategyFooter
        strategy={{ ...strategy, rulesSourceUrl: null, pricesAsOf: null }}
      />,
    );
    expect(screen.getByText('No rules source configured.')).toBeInTheDocument();
    expect(screen.getByText('Price date not available.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
