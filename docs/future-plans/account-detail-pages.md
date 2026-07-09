# Account Detail Pages for All Account Types

## Background

Loan, mortgage, and line-of-credit accounts have a dedicated detail page at `/accounts/[id]` (`LoanDetailView` / `LineOfCreditView` in `frontend/src/components/accounts/loan-detail/`). It shows summary cards, a balance/payoff chart, an amortization schedule, an overpayment simulator with saved scenarios, past-impact analysis, and a rate-history panel. Every other account type redirects from `/accounts/[id]` straight to the transaction register (`/transactions?accountId=`).

This plan extends the dedicated-page concept to the remaining account types: `CHEQUING`, `SAVINGS`, `CASH`, `CREDIT_CARD`, `INVESTMENT` (brokerage + cash pair), `ASSET`, and `OTHER`.

## Goals

- Every account gets a "home page" that answers "how is this account doing?" at a glance and offers the actions that make sense for its type.
- Maximize reuse of existing backend analytics (most of what is needed already exists and is `accountId`-aware).
- Keep the register one click away -- the detail page complements it, it does not replace it.

## Architecture

`/accounts/[id]/page.tsx` becomes the universal account detail route. Today it branches `LINE_OF_CREDIT` -> `LineOfCreditView`, `LOAN`/`MORTGAGE` -> `LoanDetailView`, and redirects everything else. The redirect is replaced with a per-type view registry:

| Account type | View component |
|---|---|
| LOAN, MORTGAGE | `LoanDetailView` (existing) |
| LINE_OF_CREDIT | `LineOfCreditView` (existing) |
| CREDIT_CARD | `CreditCardDetailView` (new) |
| CHEQUING, SAVINGS, CASH | `BankingDetailView` (new; small per-type variations) |
| INVESTMENT (brokerage or cash half) | `InvestmentDetailView` (new; resolves the pair) |
| ASSET, OTHER | `AssetDetailView` (new) |

### Shared shell (extracted first)

A common `AccountDetailShell` provides what every view needs, so each new view is mostly composition:

- `PageHeader` with account name, formatted type + currency, institution logo, and standard actions: View transactions, Reconcile (where applicable), Edit account, Export (CSV/QIF via `GET /accounts/:id/export`), Back to accounts.
- `SummaryCardGrid` -- generalized from `LoanSummaryCards` (a row of key-figure cards with label/value/subtext).
- `BalanceHistoryChart` -- already exists and is fed by `GET /accounts/daily-balances` (accountIds-aware, already projects scheduled transactions into the future).
- `UpcomingScheduledPanel` -- scheduled transactions for this account (`scheduled_transactions.accountId` / `transferAccountId`), with next due dates and skip/post shortcuts.
- `RecentActivityList` -- last N transactions with a link to the full register.
- Reconciliation status chip -- last reconciled date + uncleared count, from `GET /transactions/reconcile/:accountId` summary data.

Existing per-account analytics to reuse everywhere: transaction analytics (`GET /transactions/summary`, `grouped-totals`, `monthly-totals`, `recurring-charges` -- all accept `accountId`), net-worth monthly balances (`monthly_account_balances`), and projected balance (`AccountsService.getProjectedBalance`).

### Navigation

- Rename the row action `loanDetails` -> `details` in `AccountRow.tsx`/`AccountList.tsx` and show it for every account type.
- Keep the current row-click behaviour (register for most types, `/investments` for brokerage) unchanged in phase 1 to avoid disrupting muscle memory. Once the pages have proven themselves, consider a user preference ("account click opens: Register | Account page") in Settings -> Preferences.
- Dashboard/net-worth widgets that list accounts should deep-link to the detail page.

## Per-type design

### CREDIT_CARD -- `CreditCardDetailView`

The highest-value new page. The entity already has `creditLimit`, `interestRate`, `statementDueDay`, and `statementSettlementDay`; the missing piece is statement-cycle logic (net-new backend work).

**Show:**
- Summary cards: current balance, credit limit, available credit, utilization % (reuse the utilization bar from `LineOfCreditView`), interest rate.
- Statement panel: current cycle window (derived from `statementSettlementDay`), statement balance as of last settlement, payment due date (from `statementDueDay`) with days-remaining countdown, amount paid since statement.
- Balance history chart with statement-close markers.
- Spending breakdown for this card: by category and by payee for the current cycle / month (from `grouped-totals`).
- Recurring charges detected on this card (`GET /transactions/recurring-charges` already exists) -- "subscriptions living on this card".
- Interest & fees paid YTD (transactions in the interest category on this account).

**Do:**
- Record or schedule a payment: pre-filled transfer from a chosen funding account for statement balance / full balance / custom amount (creates a transaction or a `ScheduledTransaction`).
- Set up a due-date reminder (a cron alert like `mortgage-reminder.service.ts`).
- Reconcile against a statement (link to `/reconcile?accountId=`).
- Carried-balance payoff calculator: "paying $X/month, debt-free by ___ and $Y interest" -- reuses the loan schedule engine (`lib/loan-schedule.ts`) with revolving math.
- Edit limit / rate / statement days inline.

**New backend:** `StatementCycleService` (compute cycle boundaries + statement balance from transactions and the day-of-month fields), optional `minimumPayment`/`minimumPaymentPercent` columns, due-date reminder cron.

### CHEQUING / SAVINGS / CASH -- `BankingDetailView`

**Show:**
- Summary cards: current balance, projected balance (existing `getProjectedBalance`), money in / money out this month (`monthly-totals`), last reconciled.
- Balance history + forecast chart (daily-balances already projects scheduled transactions -- render the future segment styled like the loan page's projection).
- Upcoming bills/scheduled transactions hitting this account, including transfers in.
- Cash-flow mini-report: monthly in/out bars for the trailing 12 months.
- Top payees / top categories for this account.
- Recurring charges paid from this account.
- interest rate field surfaced (if populated), interest earned YTD (income-category transactions on this account), average balance. Automatically determine the category used for interest income. Look for terms with "Interest" in the category name and its presence/absence in the account transactions list. 

**Do:**
- Add transaction / add transfer (pre-scoped to this account).
- Reconcile.
- Manage the account's scheduled transactions.
- Low-balance alert threshold (new column + notification hook) -- pairs naturally with the projected-balance chart ("you dip below $500 on the 23rd").
- SAVINGS (later phase): savings goals -- target amount + date, progress bar, required monthly contribution. This is a net-new feature (entity + CRUD); ship it as its own follow-up rather than blocking the page.

### INVESTMENT -- `InvestmentDetailView`

Mostly composition: the `/investments` page components and the entire `portfolio` / `holdings` / `investment-transactions` API already accept `accountIds`. The view resolves the cash/brokerage pair via `GET /accounts/:id/investment-pair` and presents the logical account.

**Show:**
- Summary cards: total value (holdings + cash half), cost basis, unrealized gain/loss ($ and %), time-weighted return and CAGR (already computed by `PortfolioService.getPortfolioSummary`), cash available.
- Holdings list (`GroupedHoldingsList` scoped to the account).
- Asset allocation donut for just this account.
- Account value over time (`net-worth/investments-daily` scoped).
- Top movers today within this account.
- Income panel: dividends/interest YTD and realized capital gains (`investment-transactions/realized-gains`, `capital-gains`).
- Recent investment transactions.

**Do:**
- Add an investment transaction (buy/sell/dividend/...) pre-scoped.
- Refresh prices for this account's securities.
- Rebuild holdings.
- Set up a recurring contribution (scheduled transaction with the existing investment leg).
- Jump to the full `/investments` view filtered to this account.

### ASSET / OTHER -- `AssetDetailView`

**Show:**
- Summary cards: current value, purchase value (`openingBalance`), total and annualized appreciation since `dateAcquired`, asset category.
- Value history chart (from `monthly_account_balances` / daily-balances -- value changes are balance-adjustment transactions).
- **Equity panel when a loan is linked**: for a house + mortgage, show asset value minus linked loan balance = equity, with an equity-over-time chart. Requires a lightweight `linkedLoanAccountId` association (new nullable column) or a heuristic prompt to pick the loan.

**Do:**
- "Update value" quick action that records a balance-adjustment transaction with a date (keeps history clean without touching the register).
- Edit acquisition details / category.
- Link or unlink a loan for the equity view.

### LINE_OF_CREDIT (existing view, incremental)

Backfill the shared shell (scheduled panel, recent activity, export) and add interest-paid history and a paydown simulator reusing the credit-card carried-balance calculator.

## Backend work summary

| Item | Effort | Notes |
|---|---|---|
| Statement-cycle service + endpoints for credit cards | New service in `accounts/` or a small `statements/` module | Pure computation over transactions + day-of-month fields |
| Due-date / low-balance reminders | Small | Follow `mortgage-reminder.service.ts` pattern |
| Interest earned/paid YTD helpers | Small | Category-scoped sums via `TransactionAnalyticsService` |
| `linkedLoanAccountId` on accounts (asset equity) | Migration + DTO | Also update `database/schema.sql` |
| Optional: `minimumPayment`, `lowBalanceThreshold` columns | Migration | Only if the corresponding UI ships |
| Savings goals module | Net-new (entity, CRUD, progress calc) | Separate follow-up PR |
| Per-account params on built-in reports | Only if a page embeds one | Transaction analytics already covers most needs with `accountId` |

Any new aggregate endpoint that is also useful to the AI assistant must follow the shared-tool rule: implement on the domain service, expose through both the AI tool executor and the MCP server in the same PR.

## Rollout phases

1. **Phase 0 -- scaffolding.** Extract `AccountDetailShell` + `SummaryCardGrid`; generalize the `/accounts/[id]` branching; rename the row action to "Details" for all types; wire the shell into the two existing debt views. No behaviour change for debt accounts.
2. **Phase 1 -- Credit card.** Statement-cycle backend + `CreditCardDetailView`. Highest user value, moderate new backend.
3. **Phase 2 -- Banking.** `BankingDetailView` for chequing/savings/cash. Almost entirely reuse; fastest visible win after the shell exists.
4. **Phase 3 -- Investment.** `InvestmentDetailView` composing existing portfolio components scoped by account.
5. **Phase 4 -- Asset/Other.** `AssetDetailView` + equity linking.
6. **Follow-ups.** Savings goals; row-click preference; LOC enhancements; alert thresholds.

Each phase is a self-contained PR: English-first i18n during development with one full localization pass at acceptance, co-located component tests (the loan-detail components set the pattern), backend unit tests for any new service, and `database/schema.sql` updated alongside every migration.

## Component Structure & File Layout

### File Organization

Directory structure for a new detail view:

```
frontend/src/components/accounts/
├── loan-detail/                    (existing: pattern reference)
│   ├── LoanDetailView.tsx
│   ├── LoanDetailView.test.tsx
│   ├── LoanSummaryCards.tsx
│   ├── LoanSummaryCards.test.tsx
│   └── ...
├── credit-card-detail/             (new phase 1)
│   ├── CreditCardDetailView.tsx
│   ├── CreditCardDetailView.test.tsx
│   ├── CreditCardSummaryCards.tsx
│   ├── CreditCardSummaryCards.test.tsx
│   ├── StatementPanel.tsx
│   ├── StatementPanel.test.tsx
│   ├── SpendingBreakdown.tsx
│   ├── SpendingBreakdown.test.tsx
│   ├── PaymentSetupDialog.tsx
│   ├── PaymentSetupDialog.test.tsx
│   └── PayoffCalculator.tsx
├── banking-detail/                 (new phase 2)
│   ├── BankingDetailView.tsx
│   ├── BankingDetailView.test.tsx
│   ├── BankingSummaryCards.tsx
│   ├── CashFlowMiniReport.tsx
│   ├── LowBalanceAlertThreshold.tsx
│   └── ...
├── investment-detail/              (new phase 3)
│   ├── InvestmentDetailView.tsx
│   ├── InvestmentDetailView.test.tsx
│   └── ...
├── asset-detail/                   (new phase 4)
│   ├── AssetDetailView.tsx
│   ├── AssetDetailView.test.tsx
│   ├── EquityPanel.tsx
│   ├── EquityPanel.test.tsx
│   └── ...
├── shared/                         (extracted phase 0)
│   ├── AccountDetailShell.tsx
│   ├── AccountDetailShell.test.tsx
│   ├── PageHeader.tsx
│   ├── PageHeader.test.tsx
│   ├── SummaryCardGrid.tsx
│   ├── SummaryCardGrid.test.tsx
│   ├── BalanceHistoryChart.tsx
│   ├── BalanceHistoryChart.test.tsx
│   ├── UpcomingScheduledPanel.tsx
│   ├── UpcomingScheduledPanel.test.tsx
│   ├── RecentActivityList.tsx
│   ├── RecentActivityList.test.tsx
│   ├── ReconciliationStatusChip.tsx
│   └── ...
```

### Component Hierarchy Example (Credit Card Detail)

`AccountDetailShell` (extracted, phase 0) → composition of shared panels + credit-card-specific panels:

```
AccountDetailShell
├── PageHeader
│   ├── Account name + type
│   ├── Institution logo
│   └── Actions (View transactions, Reconcile, Edit, Export, Back)
├── CreditCardDetailView (phase 1, new)
│   ├── CreditCardSummaryCards
│   │   ├── Current balance
│   │   ├── Credit limit
│   │   ├── Available credit
│   │   ├── Utilization bar
│   │   └── Interest rate
│   ├── StatementPanel
│   │   ├── Current cycle window
│   │   ├── Statement balance as of last settlement
│   │   ├── Payment due date with countdown
│   │   └── Amount paid since statement
│   ├── BalanceHistoryChart (reused, existing)
│   │   └── with statement-close markers overlay
│   ├── SpendingBreakdown (new)
│   │   ├── By category for current cycle
│   │   └── By payee for current cycle
│   ├── RecurringChargesPanel
│   │   └── "Subscriptions on this card"
│   ├── InterestAndFeesPanel
│   │   └── YTD summary
│   ├── UpcomingScheduledPanel (reused)
│   │   └── Scoped to credit card payments
│   ├── PaymentSetupDialog (new)
│   │   └── Quick action to record/schedule payment
│   └── PayoffCalculator (new)
│       └── Carried-balance payoff simulator
├── RecentActivityList (reused)
└── ReconciliationStatusChip (reused)
```

## API Endpoint Contracts

### Existing Endpoints Used by All Detail Views

```typescript
// Already exist and are accountId-aware; reuse as-is
GET /transactions/summary?accountId=:id
  Response: { totalIn: number, totalOut: number, count: number }

GET /transactions/grouped-totals?accountId=:id&month=YYYY-MM
  Response: { label: string, amount: number }[]

GET /transactions/monthly-totals?accountId=:id&months=12
  Response: { month: string, in: number, out: number }[]

GET /transactions/recurring-charges?accountId=:id
  Response: { id, name, category, amount, frequency, nextDueDate }[]

GET /accounts/daily-balances?accountIds=:id
  Response: { date: string, balance: number, projectedBalance?: number }[]

GET /transactions/reconcile/:accountId
  Response: { lastReconciledDate: string, unclearedCount: number }

POST /accounts/:id/export?format=CSV|QIF
  Response: CSV or QIF file stream
```

### Credit Card Detail View (Phase 1) — New Endpoints

```typescript
// Statement cycle computation + statement balance
POST /credit-cards/:accountId/statement-cycle
  Request: none (derives from account.statementSettlementDay and today)
  Response: {
    cycleStart: string (YYYY-MM-DD),
    cycleEnd: string (YYYY-MM-DD),
    statementBalance: number,
    nextSettlementDate: string,
    daysUntilSettlement: number
  }

// Interest/fees paid in a date range (helper for YTD summary)
GET /accounts/:accountId/interest-paid?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
  Response: { amount: number, count: number }

// Minimum payment calculation (helper for payment UI, optional backend work)
GET /credit-cards/:accountId/minimum-payment
  Response: { amount: number, percentage?: number }
```

### Banking Detail View (Phase 2) — Extends Existing

No new endpoints required. Reuse:
- `GET /accounts/daily-balances` (already projects scheduled transactions)
- `GET /transactions/monthly-totals` (for cash-flow bars)
- `GET /transactions/grouped-totals` (for category/payee top N)
- `GET /transactions/recurring-charges`

**Helper:** Category name + presence heuristic for interest-income detection runs on frontend (no backend change).

### Investment Detail View (Phase 3) — Extends Existing

All logic exists and is accountId-scoped:

```typescript
// Already exist:
GET /investments/holdings?accountIds=:id
GET /investments/portfolio-summary?accountIds=:id
GET /investments/account-value-over-time?accountIds=:id  // daily-balances equiv
GET /investments/transactions?accountIds=:id
GET /investments/realized-gains?accountIds=:id
GET /capital-gains?accountIds=:id

// Resolve cash/brokerage pair (new, small):
GET /accounts/:id/investment-pair
  Response: {
    brokerageId: string,
    brokerageBalance: number,
    cashId: string,
    cashBalance: number,
    totalValue: number
  }
```

### Asset Detail View (Phase 4) — New Columns

```typescript
// Existing endpoint, but requires linkedLoanAccountId to be populated:
GET /accounts/:id
  Response includes: linkedLoanAccountId (nullable UUID)

// Optional new endpoint: equity computation (can run on frontend too):
GET /assets/:accountId/equity
  Response: {
    currentValue: number,
    linkedLoanBalance: number,
    equity: number,
    equityPercentage: number
  }
```

## Type Definitions & DTOs

### Frontend Types (`frontend/src/types/`)

```typescript
// account-detail.ts (new file)
export interface DetailViewProps {
  account: Account;
  isLoading: boolean;
  error?: string;
  onRefresh?: () => Promise<void>;
}

// credit-card-detail.ts (new)
export interface CreditCardSummary {
  currentBalance: number;
  creditLimit: number;
  availableCredit: number;
  utilizationPercent: number;
  interestRate: number | null;
}

export interface StatementCycle {
  cycleStart: string;
  cycleEnd: string;
  statementBalance: number;
  nextSettlementDate: string;
  daysUntilSettlement: number;
}

export interface PaymentSetup {
  accountId: string;
  fundingAccountId: string;
  amount: number;
  amountType: 'statement_balance' | 'full_balance' | 'custom';
  dueDate: string;
  saveAsRecurring: boolean;
}

export interface PayoffScenario {
  monthlyPayment: number;
  payoffMonths: number;
  totalInterest: number;
  payoffDate: string;
}

// banking-detail.ts (new)
export interface BankingSummary {
  currentBalance: number;
  projectedBalance: number;
  moneyInThisMonth: number;
  moneyOutThisMonth: number;
  interestRate: number | null;
  interestEarnedYtd: number;
}

export interface LowBalanceThreshold {
  amount: number;
  enabled: boolean;
  alertsEnabled: boolean;
}

// investment-detail.ts (new)
export interface InvestmentPairResolution {
  brokerageId: string;
  brokerageBalance: number;
  cashId: string;
  cashBalance: number;
  totalValue: number;
}

// asset-detail.ts (new)
export interface AssetEquity {
  currentAssetValue: number;
  linkedLoanBalance: number;
  equity: number;
  equityPercentage: number;
  linkedLoanName?: string;
}
```

### Backend DTOs (`backend/src/dto/`)

```typescript
// statement-cycle.dto.ts (new file)
import { IsDateString, IsNumber, IsUUID, Min } from 'class-validator';

export class StatementCycleDto {
  @IsDateString()
  cycleStart: string;

  @IsDateString()
  cycleEnd: string;

  @IsNumber()
  statementBalance: number;

  @IsDateString()
  nextSettlementDate: string;

  @IsNumber()
  @Min(0)
  daysUntilSettlement: number;
}

export class CreditCardSummaryDto {
  @IsNumber()
  currentBalance: number;

  @IsNumber()
  creditLimit: number;

  @IsNumber()
  availableCredit: number;

  @IsNumber()
  @Min(0)
  utilizationPercent: number;

  @IsNumber()
  interestRate: number | null;
}

// asset-equity.dto.ts (new)
export class AssetEquityDto {
  @IsNumber()
  currentAssetValue: number;

  @IsNumber()
  linkedLoanBalance: number;

  @IsNumber()
  equity: number;

  @IsNumber()
  equityPercentage: number;

  @IsUUID()
  linkedLoanId?: string;

  linkedLoanName?: string;
}

// low-balance-threshold.dto.ts (new)
export class LowBalanceThresholdDto {
  @IsNumber()
  amount: number;

  @IsBoolean()
  enabled: boolean;

  @IsBoolean()
  alertsEnabled: boolean;
}
```

### Database Schema Changes

```sql
-- Phase 0 (scaffolding): no schema changes

-- Phase 1 (credit card detail): no new schema (statementDueDay and statementSettlementDay exist)

-- Phase 2 (banking detail): optional low-balance threshold
ALTER TABLE accounts ADD COLUMN low_balance_threshold DECIMAL(20,4) NULL;
ALTER TABLE accounts ADD COLUMN low_balance_alerts_enabled BOOLEAN DEFAULT false;

-- Phase 4 (asset equity linking): link asset to loan
ALTER TABLE accounts ADD COLUMN linked_loan_account_id UUID NULL;
ALTER TABLE accounts ADD CONSTRAINT fk_linked_loan
  FOREIGN KEY (linked_loan_account_id) REFERENCES accounts(id) ON DELETE SET NULL;

-- Update database/schema.sql alongside every migration
```

## State Management & Data Fetching Patterns

### Zustand Store Pattern (Per-Detail-Page)

Create a store for each detail view to manage data fetching, loading, and error states:

```typescript
// store/credit-card-detail.store.ts (new, phase 1)
import { create } from 'zustand';

interface CreditCardDetailState {
  accountId: string;
  summary: CreditCardSummary | null;
  cycle: StatementCycle | null;
  spending: SpendingBreakdown | null;
  recurringCharges: RecurringCharge[];
  isLoading: boolean;
  error: string | null;
  
  setSummary: (summary: CreditCardSummary) => void;
  setCycle: (cycle: StatementCycle) => void;
  setSpending: (spending: SpendingBreakdown) => void;
  setRecurringCharges: (charges: RecurringCharge[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  
  // Async fetchers
  fetchCreditCardData: (accountId: string) => Promise<void>;
  invalidate: (accountId: string) => Promise<void>; // Called after payment or reconcile
}

export const useCreditCardDetailStore = create<CreditCardDetailState>((set) => ({
  accountId: '',
  summary: null,
  cycle: null,
  spending: null,
  recurringCharges: [],
  isLoading: false,
  error: null,

  setSummary: (summary) => set({ summary }),
  setCycle: (cycle) => set({ cycle }),
  setSpending: (spending) => set({ spending }),
  setRecurringCharges: (recurringCharges) => set({ recurringCharges }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),

  fetchCreditCardData: async (accountId: string) => {
    set({ isLoading: true, error: null, accountId });
    try {
      const [summary, cycle, spending, recurring] = await Promise.all([
        api.get<CreditCardSummary>(`/credit-cards/${accountId}/summary`),
        api.get<StatementCycle>(`/credit-cards/${accountId}/statement-cycle`),
        api.get<SpendingBreakdown>(`/transactions/grouped-totals?accountId=${accountId}`),
        api.get<RecurringCharge[]>(`/transactions/recurring-charges?accountId=${accountId}`),
      ]);
      set({
        summary: summary.data,
        cycle: cycle.data,
        spending: spending.data,
        recurringCharges: recurring.data,
        isLoading: false,
      });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  invalidate: async (accountId: string) => {
    await useCreditCardDetailStore.getState().fetchCreditCardData(accountId);
  },
}));
```

### React Hook Pattern (Inside Detail View Components)

Use `useEffect` with Zustand to fetch on mount and on account change:

```typescript
export function CreditCardDetailView({ account }: DetailViewProps) {
  const store = useCreditCardDetailStore();

  useEffect(() => {
    store.fetchCreditCardData(account.id);
  }, [account.id, store]);

  if (store.isLoading) return <Skeleton />;
  if (store.error) return <ErrorAlert onRetry={() => store.fetchCreditCardData(account.id)} />;

  return (
    <div className="space-y-6">
      {store.summary && <CreditCardSummaryCards {...store.summary} />}
      {store.cycle && <StatementPanel {...store.cycle} />}
      {/* ... */}
    </div>
  );
}
```

### Invalidation Pattern (After User Actions)

When user adds a transaction, schedules a payment, or reconciles, invalidate and refetch:

```typescript
async function handlePaymentRecorded() {
  showToast('Payment recorded');
  // Invalidate detail view data
  await useCreditCardDetailStore.getState().invalidate(accountId);
  // Invalidate account list if it's open
  useAccountsStore.getState().invalidate();
}
```

## Shared Component Inventory (Reuse)

### Already Exist in the Codebase

| Component | Location | Props | Use In |
|---|---|---|---|
| `BalanceHistoryChart` | `components/charts/` | `data: BalanceData[], projectedData?: BalanceData[], currencyCode: string` | All detail views |
| `SummaryCardGrid` | `components/ui/SummaryCardGrid.tsx` | `cards: SummaryCard[]` | All detail views |
| `SummaryCard` | `components/ui/SummaryCard.tsx` | `label: string, value: ReactNode, subtext?: string, trend?: 'up'\|'down'` | Card grids |
| `Modal` | `components/ui/Modal.tsx` | `isOpen, title, onClose, children` | Dialog overlays |
| `ConfirmDialog` | `components/ui/ConfirmDialog.tsx` | `isOpen, title, message, onConfirm, onCancel, isDangerous` | Confirm flows |
| `Toast` | react-hot-toast (via `showToast()`) | `showToast(msg, { type: 'success'\|'error' })` | Action feedback |
| `Skeleton` | `components/ui/Skeleton.tsx` | `className, count` | Loading states |
| `ErrorBoundary` | `components/ui/ErrorBoundary.tsx` | `children` | Wrap detail views |
| `useFormModal` | `hooks/useFormModal.ts` | Returns form state + modal handlers | Create/edit dialogs |
| `UtilizationBar` | `components/accounts/loan-detail/LoanSummaryCards.tsx` | `value: number, max: number, currencyCode?: string` | Credit card utilization |

### New Shared Components for Detail Views (Phase 0)

```typescript
// components/accounts/shared/AccountDetailShell.tsx
export interface AccountDetailShellProps {
  account: Account;
  isLoading: boolean;
  error?: string;
  onRefresh?: () => Promise<void>;
  onExport?: () => void;
  children: ReactNode; // The type-specific detail view body
}

export function AccountDetailShell({
  account,
  isLoading,
  error,
  onRefresh,
  onExport,
  children,
}: AccountDetailShellProps) {
  return (
    <div className="space-y-6">
      <PageHeader
        account={account}
        onExport={onExport}
        onRefresh={onRefresh}
      />
      {error && <ErrorAlert message={error} onRetry={onRefresh} />}
      {isLoading ? <Skeleton /> : children}
      <UpcomingScheduledPanel accountId={account.id} />
      <RecentActivityList accountId={account.id} limit={5} />
      <ReconciliationStatusChip accountId={account.id} />
    </div>
  );
}

// components/accounts/shared/PageHeader.tsx
// Account name, type badge, institution logo, action buttons (Edit, View Transactions, Export, Reconcile, Back)

// components/accounts/shared/UpcomingScheduledPanel.tsx
// List of scheduled transactions hitting this account; skip/post shortcuts

// components/accounts/shared/RecentActivityList.tsx
// Last N transactions with category/payee tags; link to full register

// components/accounts/shared/ReconciliationStatusChip.tsx
// Last reconciled date + uncleared count from GET /transactions/reconcile/:accountId
```

## i18n Namespace Mapping

### New Namespaces for Detail Views

Create new namespace files in `frontend/src/i18n/messages/{locale}/`:

```
accountDetail.json          # Shared UI (headers, buttons, panels)
accountDetail-creditCard.json # Credit card-specific
accountDetail-banking.json   # Banking (chequing/savings/cash)-specific
accountDetail-investment.json # Investment-specific
accountDetail-asset.json     # Asset/other-specific
```

### Sample Keys Structure

```json
{
  "accountDetail": {
    "shared": {
      "header": {
        "viewTransactions": "View Transactions",
        "reconcile": "Reconcile",
        "edit": "Edit Account",
        "export": "Export",
        "back": "Back to Accounts"
      },
      "upcoming": {
        "title": "Upcoming Scheduled Transactions",
        "empty": "No scheduled transactions"
      },
      "recent": {
        "title": "Recent Activity",
        "viewAll": "View all transactions"
      },
      "reconciliation": {
        "lastReconciled": "Last reconciled {date}",
        "unclearedCount": "{count, plural, one {# uncleared} other {# uncleared}}"
      }
    }
  },
  "accountDetail-creditCard": {
    "summary": {
      "currentBalance": "Current Balance",
      "creditLimit": "Credit Limit",
      "availableCredit": "Available Credit",
      "utilization": "Utilization",
      "interestRate": "Interest Rate"
    },
    "statement": {
      "title": "Current Statement Cycle",
      "cycleWindow": "Cycle: {start} to {end}",
      "statementBalance": "Statement Balance",
      "dueDate": "Payment Due",
      "daysRemaining": "{days, plural, one {# day remaining} other {# days remaining}}",
      "amountPaid": "Amount Paid Since Statement"
    },
    "spending": {
      "title": "Spending Breakdown",
      "byCategory": "By Category",
      "byPayee": "By Payee"
    },
    "recurring": {
      "title": "Recurring Charges",
      "subscriptionsOnCard": "Subscriptions on this card"
    },
    "interestAndFees": {
      "title": "Interest & Fees",
      "ytd": "Year-to-Date"
    },
    "paymentSetup": {
      "title": "Record Payment",
      "selectFunding": "From account",
      "amount": "Amount",
      "statementBalance": "Statement Balance",
      "fullBalance": "Full Balance",
      "custom": "Custom",
      "dueDate": "Payment Date",
      "recurring": "Save as recurring payment",
      "schedule": "Schedule",
      "record": "Record Now"
    },
    "payoff": {
      "title": "Payoff Calculator",
      "monthlyPayment": "Monthly Payment",
      "payoffMonths": "Paid off in",
      "totalInterest": "Total Interest",
      "payoffDate": "Payoff Date"
    }
  }
}
```

Remember to register new namespaces in `frontend/src/i18n/messages.ts`:

```typescript
export const messages = {
  // ...
  accountDetail: () => import('./messages/en/accountDetail.json'),
  'accountDetail-creditCard': () => import('./messages/en/accountDetail-creditCard.json'),
  'accountDetail-banking': () => import('./messages/en/accountDetail-banking.json'),
  'accountDetail-investment': () => import('./messages/en/accountDetail-investment.json'),
  'accountDetail-asset': () => import('./messages/en/accountDetail-asset.json'),
};
```

## Testing Template

### Component Test Pattern (Vitest + React Testing Library)

Pattern follows existing `loan-detail/*.test.tsx` files.

```typescript
// credit-card-detail/CreditCardDetailView.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { CreditCardDetailView } from './CreditCardDetailView';
import * as api from '@/lib/api';
import type { Account } from '@/types/account';

// Mock API layer
vi.mock('@/lib/api');

// Fixtures
const mockAccount: Account = {
  id: 'cc-123',
  accountType: 'CREDIT_CARD',
  name: 'My Visa',
  creditLimit: 5000,
  currentBalance: 1200,
  statementDueDay: 15,
  statementSettlementDay: 10,
  // ... other required fields
};

const mockCycle = {
  cycleStart: '2024-06-10',
  cycleEnd: '2024-07-09',
  statementBalance: 1200,
  nextSettlementDate: '2024-07-10',
  daysUntilSettlement: 2,
};

const mockSpending = [
  { label: 'Groceries', amount: 450 },
  { label: 'Gas', amount: 200 },
];

describe('CreditCardDetailView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state on initial mount', () => {
    vi.mocked(api.get).mockImplementation(() =>
      new Promise(() => {}) // Never resolves
    );

    render(<CreditCardDetailView account={mockAccount} isLoading={true} />);
    expect(screen.getByTestId('skeleton-loader')).toBeInTheDocument();
  });

  it('fetches and displays credit card summary cards', async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce({ data: { ...mockAccount, currentBalance: 1200 } })
      .mockResolvedValueOnce({ data: mockCycle })
      .mockResolvedValueOnce({ data: mockSpending });

    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<CreditCardDetailView account={mockAccount} isLoading={false} />);
    });

    await waitFor(() => {
      expect(screen.getByText('Current Balance')).toBeInTheDocument();
      expect(screen.getByText('$1,200.00')).toBeInTheDocument();
    });
  });

  it('displays statement cycle information', async () => {
    // Mock all API calls
    vi.mocked(api.get)
      .mockResolvedValueOnce({ data: mockCycle })
      .mockResolvedValueOnce({ data: mockSpending });

    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<CreditCardDetailView account={mockAccount} isLoading={false} />);
    });

    await waitFor(() => {
      expect(screen.getByText(/Cycle:/)).toBeInTheDocument();
      expect(screen.getByText('June 10 to July 9')).toBeInTheDocument();
    });
  });

  it('handles API errors gracefully', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('Failed to fetch'));

    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<CreditCardDetailView account={mockAccount} isLoading={false} />);
    });

    await waitFor(() => {
      expect(screen.getByText(/Failed to load/)).toBeInTheDocument();
    });
  });

  it('opens payment setup dialog on button click', async () => {
    // ... render component, mock API
    const paymentBtn = screen.getByRole('button', { name: /Record Payment/ });
    await act(async () => {
      fireEvent.click(paymentBtn);
    });

    expect(screen.getByTestId('payment-setup-dialog')).toBeInTheDocument();
  });
});
```

### Service/Hook Unit Tests

```typescript
// hooks/useCreditCardDetail.test.ts
import { renderHook, waitFor } from '@testing-library/react';
import { useCreditCardDetailStore } from '@/store/credit-card-detail.store';
import * as api from '@/lib/api';

vi.mock('@/lib/api');

describe('useCreditCardDetailStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCreditCardDetailStore.setState({
      summary: null,
      cycle: null,
      isLoading: false,
      error: null,
    });
  });

  it('fetches credit card data on demand', async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce({ data: mockCycle })
      .mockResolvedValueOnce({ data: mockSpending });

    const { result } = renderHook(() => useCreditCardDetailStore());

    await act(async () => {
      await result.current.fetchCreditCardData('cc-123');
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
      expect(result.current.cycle).toEqual(mockCycle);
    });
  });

  it('sets error on fetch failure', async () => {
    const error = new Error('Network error');
    vi.mocked(api.get).mockRejectedValue(error);

    const { result } = renderHook(() => useCreditCardDetailStore());

    await act(async () => {
      await result.current.fetchCreditCardData('cc-123');
    });

    await waitFor(() => {
      expect(result.current.error).toBe('Network error');
    });
  });
});
```

## Error Handling Pattern

Consistent error handling across all detail views using toast notifications + inline error states:

```typescript
// components/accounts/shared/ErrorAlert.tsx (new)
interface ErrorAlertProps {
  message: string;
  onRetry?: () => Promise<void>;
}

export function ErrorAlert({ message, onRetry }: ErrorAlertProps) {
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = async () => {
    if (!onRetry) return;
    setIsRetrying(true);
    try {
      await onRetry();
    } catch (err) {
      showToast((err as Error).message, { type: 'error' });
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950">
      <div className="flex items-center justify-between">
        <p className="text-sm text-red-800 dark:text-red-200">{message}</p>
        {onRetry && (
          <button
            onClick={handleRetry}
            disabled={isRetrying}
            className="text-sm font-medium text-red-600 hover:text-red-700 dark:text-red-400"
          >
            {isRetrying ? 'Retrying...' : 'Retry'}
          </button>
        )}
      </div>
    </div>
  );
}

// Usage in detail view
async function handleFetchError(err: unknown) {
  const message = err instanceof Error ? err.message : 'Failed to load account details';
  store.setError(message);
  showToast(message, { type: 'error' });
}

// Backend: ensure all API responses follow this shape
interface ApiResponse<T> {
  data: T;
  error?: { message: string; code: string };
}
```

## Accessibility Requirements

- **Page structure:** Use semantic HTML (`<main>`, `<section>`, `<article>`)
- **Headings:** `<h1>` for account name, `<h2>` for each panel (Summary, Statement, Spending, etc.)
- **ARIA labels:** Add to icon buttons and icon-only cards
- **Keyboard nav:** Tab order should follow visual flow; test with keyboard-only navigation
- **Color contrast:** All text meets WCAG AA (4.5:1 for normal text, 3:1 for large text)
- **Form labels:** Every input has an explicit `<label>` with `htmlFor`, not placeholder-only
- **Dialogs:** Use `<Modal>` which includes focus trap, ESC to close, focus restore on close
- **Loading states:** Use `aria-busy="true"` and ensure Skeleton doesn't break tab order
- **Error messages:** Link to the field causing the error with `aria-describedby` or in a live region
- **Charts:** Provide alternative text or a data table fallback for screen readers

Example accessible card:

```typescript
export function SummaryCard({ label, value, subtext, ariaLabel }: SummaryCardProps) {
  return (
    <article
      className="rounded-lg border bg-white p-4"
      aria-label={ariaLabel || label}
    >
      <h3 className="text-sm font-medium text-gray-600">{label}</h3>
      <p className="mt-2 text-2xl font-bold">{value}</p>
      {subtext && <p className="text-xs text-gray-500">{subtext}</p>}
    </article>
  );
}
```

## Implementation Checklist per Phase

### Phase 0 (Scaffolding)

- [ ] Extract `AccountDetailShell`, `PageHeader`, `SummaryCardGrid`
- [ ] Create `shared/` directory and move extracted components
- [ ] Generalize `/accounts/[id]` routing branching logic (view registry by account type)
- [ ] Rename `AccountRow` action from `loanDetails` to `details`
- [ ] Wire shell into existing `LoanDetailView` and `LineOfCreditView` (no behavior change)
- [ ] Create tests for shell + extracted components (use `LoanDetailView` as pattern)
- [ ] No backend changes

### Phase 1 (Credit Card Detail)

- [ ] Create `StatementCycleService` backend
- [ ] Add endpoints: `POST /credit-cards/:id/statement-cycle`, `GET /accounts/:id/interest-paid`
- [ ] Create `CreditCardDetailView` + sub-components in `credit-card-detail/`
- [ ] Create `useCreditCardDetailStore` for state management
- [ ] Create `i18n/accountDetail-creditCard.json` namespace (English-first)
- [ ] Add component + hook tests (visa fixtures)
- [ ] Create `PaymentSetupDialog` for quick payment recording
- [ ] Wire into `/accounts/[id]` branching
- [ ] Acceptance: full i18n pass (all 20 locales)

### Phase 2 (Banking Detail)

- [ ] Create `BankingDetailView` + sub-components in `banking-detail/`
- [ ] Reuse `BalanceHistoryChart`, `UpcomingScheduledPanel`, `RecentActivityList`
- [ ] Create `useBankingDetailStore` (simpler than credit card, most data exists)
- [ ] Create `i18n/accountDetail-banking.json` namespace
- [ ] Add low-balance threshold UI + DB columns (optional first pass)
- [ ] Component + hook tests
- [ ] Acceptance: full i18n pass

### Phase 3 (Investment Detail)

- [ ] Create `GET /accounts/:id/investment-pair` endpoint
- [ ] Create `InvestmentDetailView` composing existing portfolio components
- [ ] Scope existing holdings, transactions, asset-allocation charts by account
- [ ] Create `i18n/accountDetail-investment.json` namespace
- [ ] Component tests
- [ ] Acceptance: full i18n pass

### Phase 4 (Asset/Other Detail)

- [ ] Add `linked_loan_account_id` column to accounts
- [ ] Create `AssetDetailView` + `EquityPanel`
- [ ] Create optional `GET /assets/:id/equity` endpoint (or compute on frontend)
- [ ] Create `i18n/accountDetail-asset.json` namespace
- [ ] Component tests
- [ ] Acceptance: full i18n pass

### Cross-Phase

- [ ] Update `database/schema.sql` alongside every migration
- [ ] Maintain ≥ 91% line coverage on frontend, ≥ 85% on backend
- [ ] All new user-facing strings in i18n (English-first during dev, full pass at acceptance)
- [ ] No regressions in existing account list, transaction register, or detail pages
- [ ] Verify keyboard navigation + screen reader on all new panels
