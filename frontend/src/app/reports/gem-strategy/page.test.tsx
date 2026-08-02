import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import GemStrategyPage from './page';

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="page-layout">{children}</div>
  ),
}));

vi.mock('@/components/strategies/GemStrategyReport', () => ({
  GemStrategyReport: () => <div data-testid="gem-strategy-report" />,
}));

describe('GemStrategyPage', () => {
  it('renders the report inside the authenticated page shell', () => {
    render(<GemStrategyPage />);
    expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    expect(screen.getByTestId('gem-strategy-report')).toBeInTheDocument();
  });
});
