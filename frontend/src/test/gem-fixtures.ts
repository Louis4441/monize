import {
  GemAction,
  GemAssetRef,
  GemHistoryEntry,
  GemPerformance,
  GemPosition,
  GemSignal,
  GemStrategyReport,
} from '@/types/gem-strategy';

/**
 * Fixtures for the GEM strategy report tests. Kept under `src/test` so no
 * sample data ships in production code; every builder is a plain override-merge
 * so a test can express just the state it cares about.
 */

export const gemAssets: GemAssetRef[] = [
  { role: 'US_EQUITY', securityId: 'sec-spy', symbol: 'SPY', name: 'SPDR S&P 500 ETF' },
  { role: 'EX_US_EQUITY', securityId: 'sec-ewa', symbol: 'EWA', name: 'MSCI World ex-US ETF' },
  { role: 'EM_EQUITY', securityId: 'sec-emim', symbol: 'EMIM', name: 'iShares MSCI EM IMI ETF' },
  { role: 'SAFE', securityId: 'sec-ief', symbol: 'IEF', name: 'Treasury Bond ETF' },
  { role: 'RISK_FREE', securityId: 'sec-bil', symbol: 'BIL', name: '1-3 Month T-Bill ETF' },
];

export function gemSignal(overrides: Partial<GemSignal> = {}): GemSignal {
  return {
    id: 'signal-1',
    state: 'RISK_ON',
    target: gemAssets[2],
    targetWeightPercent: 100,
    effectiveFrom: '2025-08-01',
    evaluatedOn: '2025-08-01',
    absolute: {
      equity: { ...gemAssets[0], momentum12m: 15.42, rank: 2 },
      benchmark: { ...gemAssets[3], momentum12m: 4.21, rank: null },
      spreadPp: 11.21,
      result: 'RISK_ON',
    },
    relative: {
      ranking: [
        { ...gemAssets[2], momentum12m: 29.87, rank: 1 },
        { ...gemAssets[0], momentum12m: 15.42, rank: 2 },
        { ...gemAssets[1], momentum12m: 8.31, rank: 3 },
      ],
      winner: gemAssets[2],
      leadPp: 14.45,
      applied: true,
    },
    ...overrides,
  };
}

export function gemPosition(overrides: Partial<GemPosition> = {}): GemPosition {
  return {
    accounts: [{ id: 'acct-1', name: 'Broker IRA' }],
    holdings: [
      {
        ...gemAssets[0],
        quantity: 51,
        marketValue: 23076.26,
        matchPercent: 0,
        matchedByInstrument: false,
        isCash: false,
        matchedMarkets: [],
      },
      {
        ...gemAssets[2],
        quantity: 1170,
        marketValue: 41024.46,
        matchPercent: 100,
        matchedByInstrument: false,
        isCash: false,
        matchedMarkets: [],
      },
      // A holding the strategy never assigned still counts.
      {
        role: null,
        securityId: 'sec-wtai',
        symbol: 'WTAI',
        name: 'WisdomTree Artificial Intelligence UCITS ETF',
        quantity: 6,
        marketValue: 543.12,
        matchPercent: 0,
        matchedByInstrument: true,
        isCash: false,
        matchedMarkets: [],
      },
    ],
    current: {
      ...gemAssets[0],
      quantity: 51,
      marketValue: 23076.26,
      matchPercent: 0,
      matchedByInstrument: false,
      isCash: false,
      matchedMarkets: [],
    },
    target: gemAssets[2],
    compliancePercent: 64,
    changeRequired: true,
    totalMarketValue: 64643.84,
    basis: 'COMPOSITION',
    dimension: 'COUNTRY',
    requiredDimension: 'COUNTRY',
    instrumentMatchedCount: 1,
    currencyCode: 'CAD',
    ...overrides,
  };
}

export function gemAction(overrides: Partial<GemAction> = {}): GemAction {
  return {
    required: true,
    from: {
      ...gemAssets[0],
      quantity: 51,
      marketValue: 23076.26,
      matchPercent: 0,
      matchedByInstrument: false,
      isCash: false,
      matchedMarkets: [],
    },
    fromCount: 2,
    to: gemAssets[2],
    targetWeightPercent: 100,
    transferValue: 23076.26,
    realizedGainLoss: 4794.9,
    estimatedTax: 911.03,
    taxRatePercent: 19,
    estimatedCommission: 59.8,
    estimatedTradeCount: 2,
    partialMatchCount: 0,
    accounts: [{ id: 'acct-1', name: 'Broker IRA' }],
    currencyCode: 'CAD',
    executed: false,
    ...overrides,
  };
}

export function gemPerformance(overrides: Partial<GemPerformance> = {}): GemPerformance {
  return {
    range: '1Y',
    points: [
      {
        date: '2024-08-01',
        values: { US_EQUITY: 0, EX_US_EQUITY: 0, EM_EQUITY: 0, SAFE: 0 },
      },
      {
        date: '2025-02-01',
        values: { US_EQUITY: 8.1, EX_US_EQUITY: 4.2, EM_EQUITY: 12.4, SAFE: 2.1 },
      },
      {
        date: '2025-08-01',
        values: { US_EQUITY: 15.42, EX_US_EQUITY: 8.31, EM_EQUITY: 29.87, SAFE: 4.21 },
      },
    ],
    totals: { US_EQUITY: 15.42, EX_US_EQUITY: 8.31, EM_EQUITY: 29.87, SAFE: 4.21 },
    currencyCode: 'CAD',
    incomplete: false,
    ...overrides,
  };
}

export function gemHistory(): GemHistoryEntry[] {
  return [
    {
      id: 'hist-1',
      evaluatedOn: '2025-08-01',
      effectiveFrom: '2025-08-01',
      winner: gemAssets[2],
      state: 'RISK_ON',
      action: 'SWITCH',
      momentum: { US_EQUITY: 15.42, EX_US_EQUITY: 8.31, EM_EQUITY: 29.87, SAFE: 4.21 },
      change: { from: gemAssets[0], to: gemAssets[2] },
      executed: false,
    },
    {
      id: 'hist-2',
      evaluatedOn: '2025-07-01',
      effectiveFrom: '2025-07-01',
      winner: gemAssets[1],
      state: 'RISK_ON',
      action: 'SWITCH',
      momentum: { US_EQUITY: 7.12, EX_US_EQUITY: 8.31, EM_EQUITY: 8.31, SAFE: 4.08 },
      change: { from: gemAssets[2], to: gemAssets[1] },
      executed: true,
    },
    {
      id: 'hist-3',
      evaluatedOn: '2025-06-01',
      effectiveFrom: '2025-06-01',
      winner: gemAssets[3],
      state: 'RISK_OFF',
      action: 'HOLD',
      momentum: { US_EQUITY: -1.28, EX_US_EQUITY: 1.45, EM_EQUITY: 3.12, SAFE: 3.76 },
      change: null,
      executed: null,
    },
  ];
}

export function gemReport(overrides: Partial<GemStrategyReport> = {}): GemStrategyReport {
  return {
    strategy: {
      id: 'strategy-1',
      name: 'GEM',
      cadence: 'MONTHLY',
      lookbackMonths: 12,
      taxRatePercent: 19,
      commissionAmount: 29.9,
      nextEvaluationOn: '2025-08-31',
      daysUntilNextEvaluation: 28,
      pricesAsOf: '2025-08-02',
      rulesSourceUrl: 'https://example.test/gem',
      rulesSourceLabel: 'example.test/gem',
      accounts: [{ id: 'acct-1', name: 'Broker IRA' }],
    },
    strategies: [{ id: 'strategy-1', name: 'GEM' }],
    assets: gemAssets,
    signal: gemSignal(),
    position: gemPosition(),
    action: gemAction(),
    performance: gemPerformance(),
    history: gemHistory(),
    backtest: {
      from: '2000-01-01',
      to: '2025-08-01',
      cagrPercent: 11.4,
      maxDrawdownPercent: -22.6,
      hitRatePercent: 68.2,
      netOfCosts: true,
      coveragePercent: 100,
    },
    warnings: [],
    ...overrides,
  };
}
