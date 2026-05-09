-- First-class scheduled investment transactions: recurring buys (DCA),
-- recurring dividends, DRIP/REINVEST, and bank-funded contribution+buy.
-- Posts via InvestmentTransactionsService, which creates the linked cash
-- transaction and updates holdings atomically.

CREATE TABLE IF NOT EXISTS scheduled_investment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  funding_account_id UUID REFERENCES accounts(id),
  security_id UUID REFERENCES securities(id),
  action investment_action NOT NULL,
  name VARCHAR(255) NOT NULL,
  quantity NUMERIC(20, 8),
  price NUMERIC(20, 6),
  commission NUMERIC(20, 4) DEFAULT 0,
  total_amount NUMERIC(20, 4),
  currency_code VARCHAR(3),
  exchange_rate NUMERIC(20, 10),
  description TEXT,
  frequency VARCHAR(20) NOT NULL,
  next_due_date DATE NOT NULL,
  start_date DATE,
  end_date DATE,
  occurrences_remaining INT,
  total_occurrences INT,
  is_active BOOLEAN DEFAULT TRUE,
  auto_post BOOLEAN DEFAULT FALSE,
  reminder_days_before INT DEFAULT 3,
  last_posted_date DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT chk_sit_frequency CHECK (
    frequency IN (
      'ONCE', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'EVERY4WEEKS',
      'SEMIMONTHLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_sit_user
  ON scheduled_investment_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_sit_next_due
  ON scheduled_investment_transactions(next_due_date);
CREATE INDEX IF NOT EXISTS idx_sit_account
  ON scheduled_investment_transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_sit_security
  ON scheduled_investment_transactions(security_id);
CREATE INDEX IF NOT EXISTS idx_sit_active_due
  ON scheduled_investment_transactions(is_active, auto_post, next_due_date);
