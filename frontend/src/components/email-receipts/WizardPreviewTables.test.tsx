import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@/test/render';
import { WizardPreviewTables } from './WizardPreviewTables';
import type { ParserPreviewItem, ParserPreviewResult } from '@/types/email-receipts';

const item = (over: Partial<ParserPreviewItem> = {}): ParserPreviewItem => ({
  receiptId: 'r-1',
  subject: 'Your order has been filled',
  receivedAt: '2026-10-15T16:10:19.000Z',
  effectiveDate: '2026-10-15T16:10:19.000Z',
  outcome: 'trade',
  statusReason: null,
  trade: { action: 'BUY', symbol: 'XCNS', quantity: 75.9878, consistent: true },
  parsed: { date: '2026-10-15', total: 2000, currency: null, lineCount: 0 },
  match: null,
  expected: null,
  agrees: null,
  ...over,
});

const result = (over: Partial<ParserPreviewResult> = {}): ParserPreviewResult => ({
  selected: [],
  others: [],
  othersTotal: 0,
  ...over,
});

describe('WizardPreviewTables of a trade profile', () => {
  it('shows the trade each email reports, with the total as a plain number, and no line count', () => {
    render(<WizardPreviewTables result={result({ selected: [item()] })} />);
    const row = screen.getByRole('row', { name: /Your order has been filled/ });
    expect(within(row).getByText('Buys 75.9878 shares of XCNS')).toBeInTheDocument();
    expect(within(row).getByText('Total: 2,000.00')).toBeInTheDocument();
    expect(within(row).queryByText(/lines?$/)).not.toBeInTheDocument();
  });

  it('says a trade whose price does not fit the total will not auto-apply', () => {
    render(
      <WizardPreviewTables
        result={result({ selected: [item({ trade: { action: 'SELL', symbol: 'XCNS', quantity: 10, consistent: false } })] })}
      />,
    );
    expect(screen.getByText('Sells 10 shares of XCNS')).toBeInTheDocument();
    expect(screen.getByText('The price does not match the total, so it will not be applied automatically')).toBeInTheDocument();
  });

  it('labels the outcome and names why an incomplete trade could not be read', () => {
    render(
      <WizardPreviewTables
        result={result({
          others: [
            item({ receiptId: 'r-2', subject: 'Filled A' }),
            item({
              receiptId: 'r-3',
              subject: 'Filled B',
              outcome: 'parse_failed',
              statusReason: 'trade_no_symbol',
              trade: { action: 'BUY', symbol: null, quantity: 5, consistent: null },
              parsed: { date: '2026-10-15', total: null, currency: null, lineCount: 0 },
            }),
          ],
          othersTotal: 2,
        })}
      />,
    );
    expect(within(screen.getByRole('row', { name: /Filled A/ })).getByText('Proposes a trade')).toBeInTheDocument();
    const failed = screen.getByRole('row', { name: /Filled B/ });
    expect(within(failed).getByText('Could not be read')).toBeInTheDocument();
    expect(within(failed).getByText('The profile found no ticker symbol in this email.')).toBeInTheDocument();
    expect(within(failed).getByText('Nothing could be read')).toBeInTheDocument();
  });
});
