import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@/test/render';
import { RuleApplications, transactionHref } from './RuleApplications';
import { testOptions } from './rule-test-harness';
import { COFFEE_ID, PAYEE_ID, TAG_ID, makeApplication } from './rules-test-fixtures';

const api = vi.hoisted(() => ({ getApplications: vi.fn() }));

vi.mock('@/lib/transaction-rules-api', () => ({ transactionRulesApi: api }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

async function renderApplications() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<RuleApplications ruleId="rule-1" options={testOptions} />);
  });
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RuleApplications', () => {
  it('lists the latest applications with the change in words, the source and a link to each transaction', async () => {
    api.getApplications.mockResolvedValue([
      makeApplication(),
      makeApplication({
        id: 'app-2',
        transactionId: 'tx-2',
        payeeName: null,
        amount: 12,
        source: 'manual',
        changes: {
          payeeId: { before: null, after: PAYEE_ID },
          tagIds: { before: [TAG_ID], after: [] },
        },
      }),
      makeApplication({ id: 'app-3', transactionId: 'tx-3', source: 'create', changes: { categoryId: { before: COFFEE_ID, after: 'gone' } } }),
      makeApplication({ id: 'app-4', transactionId: 'tx-4', source: 'newer-source' }),
    ]);
    await renderApplications();

    expect(api.getApplications).toHaveBeenCalledWith('rule-1');
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);

    expect(rows[0]).toHaveTextContent('Corner Cafe');
    expect(rows[0]).toHaveTextContent('-$4.50');
    expect(rows[0]).toHaveTextContent('Imported');
    expect(rows[0]).toHaveTextContent('Category: none → Food: Coffee');
    expect(rows[0]).toHaveTextContent('08/14/2026')
    expect(rows[0]).toHaveTextContent('09/01/2026');

    expect(rows[1]).toHaveTextContent('No payee');
    expect(rows[1]).toHaveTextContent('Manual run');
    expect(rows[1]).toHaveTextContent('Payee: none → Corner Cafe');
    expect(rows[1]).toHaveTextContent('Tags removed: Coffee run');

    expect(rows[2]).toHaveTextContent('Created');
    expect(rows[2]).toHaveTextContent('Category: Food: Coffee → a deleted item');
    expect(rows[3]).toHaveTextContent('Other');

    const link = within(rows[0]).getByRole('link');
    expect(link).toHaveAttribute('href', '/transactions?targetTransactionId=tx-1');
    expect(within(rows[1]).getByRole('link')).toHaveAttribute('href', '/transactions?targetTransactionId=tx-2');
  });

  it('builds the deep link the register jumps to', () => {
    expect(transactionHref('11111111-1111-4111-8111-111111111111')).toBe(
      '/transactions?targetTransactionId=11111111-1111-4111-8111-111111111111',
    );
  });

  it('says the rule has not changed anything yet when the trace is empty', async () => {
    api.getApplications.mockResolvedValue([]);
    await renderApplications();
    expect(screen.getByText('This rule has not changed anything yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows a spinner while loading', async () => {
    api.getApplications.mockReturnValue(new Promise(() => {}));
    await renderApplications();
    expect(screen.getByText('Loading the history...')).toBeInTheDocument();
  });

  it('shows a failed load as an error with a retry, never as the empty message', async () => {
    api.getApplications.mockRejectedValueOnce(new Error('offline'));
    await renderApplications();
    expect(screen.getByRole('alert')).toHaveTextContent('The history could not be loaded');
    expect(screen.queryByText('This rule has not changed anything yet')).not.toBeInTheDocument();

    api.getApplications.mockResolvedValueOnce([makeApplication()]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Corner Cafe')).toBeInTheDocument();
    expect(api.getApplications).toHaveBeenCalledTimes(2);
  });
});
