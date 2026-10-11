import { describe, it, expect } from 'vitest';
import { benchmarkLabel, issuerLabel, programLabel } from './bond-labels';

const translator = (messages: Record<string, string>) => {
  const t = ((key: string) => messages[key]) as ((key: string) => string) & {
    has: (key: string) => boolean;
  };
  t.has = (key: string) => key in messages;
  return t;
};

describe('bond labels', () => {
  const t = translator({
    'bond.benchmarks.PL_CPI_GUS_YOY': 'CPI',
    'bond.issuers.PL_MF': 'Ministry of Finance (PL)',
    'bond.programs.EDO': '10-year indexed bonds',
  });

  it('uses the translated name where the catalog has one', () => {
    expect(benchmarkLabel(t, 'PL_CPI_GUS_YOY')).toBe('CPI');
    expect(issuerLabel(t, 'PL_MF')).toBe('Ministry of Finance (PL)');
    expect(programLabel(t, 'EDO')).toBe('10-year indexed bonds');
  });

  it('falls back to the code, never to an empty string', () => {
    expect(issuerLabel(t, 'XX_NEW')).toBe('XX_NEW');
    expect(programLabel(t, 'NEW')).toBe('NEW');
  });
});
