import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@/test/render';
import RulesPage from './page';

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/transaction-rules-api', () => ({
  transactionRulesApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

describe('RulesPage', () => {
  it('renders the header with a create link to the editor route', async () => {
    await act(async () => {
      render(<RulesPage />);
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Rules' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create rule' })).toHaveAttribute('href', '/rules/new');
    expect(screen.getByText('No rules yet')).toBeInTheDocument();
  });
});
