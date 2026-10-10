CREATE TABLE IF NOT EXISTS account_portfolios (
  portfolio_id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  product_code TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (product_code) REFERENCES commercial_products(product_code)
);

CREATE TABLE IF NOT EXISTS portfolio_accounts (
  portfolio_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  tier INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'watching',
  notes TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (portfolio_id, target_account_id),
  FOREIGN KEY (portfolio_id) REFERENCES account_portfolios(portfolio_id) ON DELETE CASCADE,
  FOREIGN KEY (target_account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS client_portal_tokens (
  token_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  subscriber_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  problem_category TEXT,
  source TEXT,
  consent_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS newsletter_deliveries (
  delivery_id TEXT PRIMARY KEY,
  asset_id TEXT,
  subscriber_id TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_id TEXT,
  error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES content_assets(asset_id) ON DELETE SET NULL,
  FOREIGN KEY (subscriber_id) REFERENCES newsletter_subscribers(subscriber_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portfolios_owner ON account_portfolios(owner_account_id,status);
CREATE INDEX IF NOT EXISTS idx_portfolio_accounts_portfolio ON portfolio_accounts(portfolio_id,tier);
CREATE INDEX IF NOT EXISTS idx_portal_tokens_account ON client_portal_tokens(account_id,status);
CREATE INDEX IF NOT EXISTS idx_newsletter_status ON newsletter_subscribers(status,problem_category);
