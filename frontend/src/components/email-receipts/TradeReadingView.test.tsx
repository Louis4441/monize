import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { TradeReadingView } from './TradeReadingView';
import { PARSED_TRADE } from './email-receipts-fixtures';
import { readParsedTrade } from '@/types/email-receipts';

const trade = (over: Record<string, unknown> = {}) => {
  const read = readParsedTrade({ ...PARSED_TRADE, ...over });
  if (read === null) throw new Error('fixture is not a trade');
  return read;
};

describe('TradeReadingView', () => {
  it('says what the profile read, the total divided by 10000', () => {
    render(<TradeReadingView trade={trade()} fallbackDate="2026-10-16T00:00:00.000Z" />);
    expect(screen.getByText(/Buy 75\.9878 shares of XCNS for 2,000\.00, dated /)).toBeInTheDocument();
    expect(screen.getByText('Account named in the email: RRSP')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('reads a sell', () => {
    render(<TradeReadingView trade={trade({ action: 'SELL' })} fallbackDate={null} />);
    expect(screen.getByText(/^Sell 75\.9878 shares of XCNS/)).toBeInTheDocument();
  });

  it('dates the trade by the email when it states no date, and says so when even that is unknown', () => {
    const { rerender } = render(<TradeReadingView trade={trade({ date: null })} fallbackDate="2026-10-14T12:00:00.000Z" />);
    expect(screen.getByText(/dated .*2026|dated .*14/)).toBeInTheDocument();
    rerender(<TradeReadingView trade={trade({ date: null })} fallbackDate={null} />);
    expect(screen.getByText(/dated the day the email arrived\./)).toBeInTheDocument();
  });

  it('says the total is implied by the price when the email states none', () => {
    render(<TradeReadingView trade={trade({ total: null, consistent: null })} fallbackDate={null} />);
    expect(screen.getByText(/for the total implied by the price/)).toBeInTheDocument();
  });

  it('warns that a price that does not fit will not be applied automatically', () => {
    render(<TradeReadingView trade={trade({ consistent: false })} fallbackDate={null} />);
    expect(screen.getByRole('note')).toHaveTextContent('will not be applied automatically');
  });

  it('shows no account line when the email names none', () => {
    render(<TradeReadingView trade={trade({ accountText: null })} fallbackDate={null} />);
    expect(screen.queryByText(/Account named in the email/)).not.toBeInTheDocument();
  });

  it('shows the price the email states, and money in the currency the email names', () => {
    const { rerender } = render(<TradeReadingView trade={trade()} fallbackDate={null} />);
    expect(screen.getByText('Average price in the email: 26.3200 a share')).toBeInTheDocument();
    rerender(<TradeReadingView trade={trade({ currency: 'USD' })} fallbackDate={null} />);
    expect(screen.getByText(/for \$2,000\.00, dated/)).toBeInTheDocument();
  });

  it('names the reason of an incomplete reading only where it is asked to', () => {
    const incomplete = trade({ complete: false, accountId: null, reason: 'trade_no_account' });
    const { rerender } = render(<TradeReadingView trade={incomplete} fallbackDate={null} />);
    expect(screen.queryByText(/account/i)).not.toBeInTheDocument();
    rerender(<TradeReadingView trade={incomplete} fallbackDate={null} showReason />);
    expect(screen.getByText(/account/i)).toBeInTheDocument();
  });

  it('says nothing was read rather than inventing a sentence from an incomplete reading', () => {
    render(
      <TradeReadingView trade={trade({ complete: false, symbol: null, reason: 'trade_no_symbol' })} fallbackDate={null} />,
    );
    expect(screen.getByText('The profile could not read a complete trade from this email.')).toBeInTheDocument();
  });
});

describe('readParsedTrade', () => {
  it('reads what the API stores', () => {
    expect(readParsedTrade(PARSED_TRADE)).toEqual(PARSED_TRADE);
  });

  it.each([
    ['nothing', null],
    ['an unknown direction', { ...PARSED_TRADE, action: 'HOLD' }],
    ['a string quantity', { ...PARSED_TRADE, quantity: '75' }],
    ['a missing complete flag', { ...PARSED_TRADE, complete: undefined }],
    ['a non-boolean consistent', { ...PARSED_TRADE, consistent: 'yes' }],
  ])('refuses %s', (_why, value) => {
    expect(readParsedTrade(value as Record<string, unknown> | null)).toBeNull();
  });
});
