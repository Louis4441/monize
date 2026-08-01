import { CreateSecurityData } from '@/types/investment';
import { GemAssetRole } from '@/types/gem-strategy';

/**
 * Starting instruments per GEM role, for a portfolio that has never held one.
 *
 * Each entry is a widely held, long-lived ETF tracking the index its role is
 * defined by, with enough history for the momentum window. They are a starting
 * point, not advice: every role can be pointed at a different instrument.
 *
 * Suggestions come in regional listings because the same index is bought
 * through a different fund depending on where the account is. A US brokerage
 * buys the US-listed ETF; a European one generally cannot, and buys the UCITS
 * equivalent instead. Monize has no regional setting to choose between them, so
 * the picker offers both and the investor picks the listing their broker
 * actually trades -- the exchange and currency are theirs to confirm when the
 * instrument is created.
 *
 * The two defensive roles are deliberately different funds, which is how the
 * original rules read: T-bills are the yardstick the absolute test measures
 * against, while a RISK-OFF period is spent in an aggregate bond fund.
 */
export const GEM_SUGGESTION_REGIONS = ['AMERICAS', 'EUROPE'] as const;

export type GemSuggestionRegion = (typeof GEM_SUGGESTION_REGIONS)[number];

export interface GemSuggestedSecurity extends CreateSecurityData {
  role: GemAssetRole;
  region: GemSuggestionRegion;
  symbol: string;
  name: string;
}

/**
 * The listing the one-click "fill the missing roles" button uses. The picker
 * shows every region; the button has to commit to one, and the US listings are
 * the ones the strategy's own literature is written against.
 */
export const GEM_DEFAULT_SUGGESTION_REGION: GemSuggestionRegion = 'AMERICAS';

export const GEM_SUGGESTED_SECURITIES: readonly GemSuggestedSecurity[] = [
  // Americas -- US-listed, the funds Antonacci's rules are usually run with.
  {
    role: 'US_EQUITY',
    region: 'AMERICAS',
    symbol: 'SPY',
    name: 'SPDR S&P 500 ETF Trust',
    securityType: 'ETF',
    exchange: 'NYSEARCA',
    currencyCode: 'USD',
  },
  {
    role: 'EX_US_EQUITY',
    region: 'AMERICAS',
    symbol: 'VEU',
    name: 'Vanguard FTSE All-World ex-US ETF',
    securityType: 'ETF',
    exchange: 'NYSEARCA',
    currencyCode: 'USD',
  },
  {
    role: 'EM_EQUITY',
    region: 'AMERICAS',
    symbol: 'EEM',
    name: 'iShares MSCI Emerging Markets ETF',
    securityType: 'ETF',
    exchange: 'NYSEARCA',
    currencyCode: 'USD',
  },
  {
    role: 'SAFE',
    region: 'AMERICAS',
    symbol: 'AGG',
    name: 'iShares Core U.S. Aggregate Bond ETF',
    securityType: 'ETF',
    exchange: 'NYSEARCA',
    currencyCode: 'USD',
  },
  {
    role: 'RISK_FREE',
    region: 'AMERICAS',
    symbol: 'BIL',
    name: 'SPDR Bloomberg 1-3 Month T-Bill ETF',
    securityType: 'ETF',
    exchange: 'NYSEARCA',
    currencyCode: 'USD',
  },

  // Europe -- UCITS listings, which is what a European broker can actually
  // buy. All five are USD-denominated, so the strategy switches between them
  // without a currency conversion on every move.
  {
    role: 'US_EQUITY',
    region: 'EUROPE',
    symbol: 'CSPX',
    name: 'iShares Core S&P 500 UCITS ETF',
    securityType: 'ETF',
    exchange: 'LSE',
    currencyCode: 'USD',
  },
  {
    role: 'EX_US_EQUITY',
    region: 'EUROPE',
    symbol: 'EXUS',
    name: 'Xtrackers MSCI World ex USA UCITS ETF',
    securityType: 'ETF',
    exchange: 'XETRA',
    currencyCode: 'USD',
  },
  {
    role: 'EM_EQUITY',
    region: 'EUROPE',
    symbol: 'EMIM',
    name: 'iShares Core MSCI EM IMI UCITS ETF',
    securityType: 'ETF',
    exchange: 'LSE',
    currencyCode: 'USD',
  },
  {
    role: 'SAFE',
    region: 'EUROPE',
    symbol: 'AGGG',
    name: 'iShares Core Global Aggregate Bond UCITS ETF',
    securityType: 'ETF',
    exchange: 'LSE',
    currencyCode: 'USD',
  },
  {
    role: 'RISK_FREE',
    region: 'EUROPE',
    symbol: 'IB01',
    name: 'iShares $ Treasury Bond 0-1yr UCITS ETF',
    securityType: 'ETF',
    exchange: 'LSE',
    currencyCode: 'USD',
  },
] as const;

/** Every suggestion for a role, in region order. */
export function suggestionsForRole(
  role: GemAssetRole,
): readonly GemSuggestedSecurity[] {
  return GEM_SUGGESTED_SECURITIES.filter((entry) => entry.role === role);
}

/** The suggestion for a role in one region, or undefined when it has none. */
export function suggestedSecurityFor(
  role: GemAssetRole,
  region: GemSuggestionRegion = GEM_DEFAULT_SUGGESTION_REGION,
): GemSuggestedSecurity | undefined {
  return GEM_SUGGESTED_SECURITIES.find(
    (entry) => entry.role === role && entry.region === region,
  );
}
